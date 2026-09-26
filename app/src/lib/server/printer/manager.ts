// All saved printers and their live connections. The registry lives in the `printers` table (Settings →
// Printers is the source of truth; the old BAMBU_* env variables are imported once), each enabled
// printer gets a BambuPrinter connection, and every status change is turned into typed bus events
// (diff.ts). Writes are versioned like the rest of the workspace and announced with lab.touch.
import { EventEmitter } from 'node:events';
import { and, asc, eq, max, sql } from 'drizzle-orm';
import type { DB } from '../db';
import { meta, printers } from '../db/schema';
import type { Lab } from '../lab';
import type { EventBus, LabEvent } from '../events';
import {
	AppError,
	parse,
	printerInput,
	printerPatch,
	printerReorder,
	printerTest
} from '../validation';
import { BambuPrinter, type ConnectionOptions, type PrinterConfig } from './bambu';
import { diffStatus } from './diff';
import { discoverPrinters } from './discovery';
import { firmwareVersion } from './report';
import {
	PRINTER_MODELS,
	capabilitiesFor,
	detectModel,
	isModelCode,
	type ModelCode
} from '$lib/shared/printers/models';
import type { DiscoveredPrinter, PrinterInfo } from '$lib/shared/printers/info';
import type { PrinterStatus } from '$lib/shared/printers/status';

export interface PrinterManagerOptions {
	env: Record<string, string | undefined>;
	log: (m: string) => void;
	/** CA certificates instead of the bundled Bambu ones (tests). */
	ca?: (string | Buffer)[];
	/** How long a printer must stay disconnected before printer.offline is emitted (default 10 s). */
	offlineAfterMs?: number;
}

type Row = typeof printers.$inferSelect;
const CONNECTION_FIELDS = [
	'host',
	'serial',
	'accessCode',
	'port',
	'ftpPort',
	'tls',
	'simulated',
	'model'
] as const;
const ENV_IMPORTED = 'printers_env_imported';
const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

/** Emits 'update' (printerId) on every status change and 'changed' when the registry changes. */
export class PrinterManager extends EventEmitter {
	private connections = new Map<string, BambuPrinter>();
	private previous = new Map<string, PrinterStatus>();
	private offline = new Map<string, NodeJS.Timeout>();
	private reportedOffline = new Set<string>();
	private printStarted = new Map<string, number>();
	/** Rows whose next connection was started by the person, so an unknown certificate may be pinned. */
	private mayPin = new Set<string>();
	/** Pins found by Test before the printer was saved, by serial. */
	private pendingPins = new Map<string, string>();
	private discoveryWarning: string | undefined;

	constructor(
		private db: DB,
		private lab: Lab,
		private bus: EventBus,
		private options: PrinterManagerOptions
	) {
		super();
		this.setMaxListeners(200);
		lab.printerTrust = (id) => this.connections.get(id)?.trust ?? null;
	}

	/** Env import (once), PRINTLAB_PRINTERS (every boot), then one connection per enabled printer. */
	start(): void {
		this.importEnv();
		this.importFleet();
		for (const row of this.rows()) if (row.enabled) this.connect(row);
		const count = this.connections.size;
		this.options.log(
			count
				? `Printers: ${this.list()
						.map(
							(p) =>
								`${p.name}${p.config.simulated ? ' (SIMULATOR)' : ''} at ${p.config.host}:${p.config.port ?? 8883}`
						)
						.join(', ')}`
				: 'Printers: none set up'
		);
	}

	stop(): void {
		for (const timer of this.offline.values()) clearTimeout(timer);
		this.offline.clear();
		for (const p of this.connections.values()) p.stop();
		this.connections.clear();
	}

	// ---------- Reads ----------

	private rows(): Row[] {
		return this.db
			.select()
			.from(printers)
			.orderBy(asc(printers.sortOrder), asc(printers.createdAt))
			.all();
	}

	private row(id: string): Row | undefined {
		return this.db.select().from(printers).where(eq(printers.id, id)).get();
	}

	/** Enabled printers' connections, in sort order. */
	list(): BambuPrinter[] {
		return this.rows()
			.map((r) => this.connections.get(r.id))
			.filter((p): p is BambuPrinter => !!p);
	}

	get(id: string): BambuPrinter | undefined {
		return this.connections.get(id);
	}

	require(id: string): BambuPrinter {
		const p = this.connections.get(id);
		if (p) return p;
		if (this.row(id)) throw new AppError(409, 'That printer is switched off in Settings.');
		throw new AppError(404, 'That printer no longer exists.');
	}

	/** The first enabled printer in sort order: what single-printer callers (cloud v1, kid page) use. */
	primary(): BambuPrinter | null {
		return this.list()[0] ?? null;
	}

	/** Every saved printer's status (switched-off ones too), in sort order. */
	statuses(): PrinterStatus[] {
		return this.rows().map((r) => this.status(r));
	}

	statusOf(id: string): PrinterStatus {
		const row = this.row(id);
		if (!row) throw new AppError(404, 'That printer no longer exists.');
		return this.status(row);
	}

	private status(row: Row): PrinterStatus {
		const live = this.connections.get(row.id);
		if (live) return live.status();
		const model = PRINTER_MODELS[row.model] ?? PRINTER_MODELS.N6;
		return {
			configured: true,
			id: row.id,
			name: row.name,
			model: model.code,
			modelName: model.name,
			caps: capabilitiesFor(model.code, null),
			camera: model.camera,
			enabled: false,
			simulated: row.simulated,
			connected: false,
			lastSeen: null,
			error: 'Switched off in Settings.',
			warning: '',
			printing: false,
			state: null
		};
	}

	info(): PrinterInfo[] {
		return this.lab.printers();
	}

	private infoOf(id: string): PrinterInfo {
		const info = this.info().find((p) => p.id === id);
		if (!info) throw new AppError(404, 'That printer no longer exists.');
		return info;
	}

	// ---------- Connections and events ----------

	private config(row: Row): PrinterConfig {
		return {
			id: row.id,
			model: isModelCode(row.model) ? row.model : 'N6',
			host: row.host,
			serial: row.serial,
			accessCode: row.accessCode,
			name: row.name,
			port: row.port,
			ftpPort: row.ftpPort,
			useTls: row.tls,
			simulated: row.simulated,
			enabled: row.enabled,
			tlsPin: row.tlsPin
		};
	}

	private connectionOptions(id: string): ConnectionOptions {
		return {
			mayPin: this.mayPin.has(id),
			onPin: (pin) => {
				this.mayPin.delete(id);
				this.savePin(id, pin);
			},
			ca: this.options.ca,
			log: this.options.log
		};
	}

	private savePin(id: string, pin: string) {
		// Not a user edit: no version bump, so an open Settings form does not conflict.
		this.db.update(printers).set({ tlsPin: pin }).where(eq(printers.id, id)).run();
		this.lab.touch('printer');
	}

	private connect(row: Row) {
		this.disconnect(row.id);
		const printer = new BambuPrinter(this.config(row), this.connectionOptions(row.id));
		this.connections.set(row.id, printer);
		printer.on('update', () => this.onUpdate(printer));
		printer.start();
	}

	private disconnect(id: string) {
		const p = this.connections.get(id);
		if (!p) return;
		p.stop();
		p.removeAllListeners('update');
		this.connections.delete(id);
		this.previous.delete(id);
		clearTimeout(this.offline.get(id));
		this.offline.delete(id);
		this.reportedOffline.delete(id);
		this.emit('update', id);
	}

	/** Status change → events (with offline debounced, so a flapping connection stays quiet). */
	private onUpdate(printer: BambuPrinter) {
		const id = printer.id;
		const next = printer.status();
		const prev = this.previous.get(id) ?? null;
		this.previous.set(id, structuredClone(next));
		const events = diffStatus({ id, name: printer.name }, prev, next, (task) =>
			this.lab.jobIdForTask(id, task)
		);
		for (const event of events) this.dispatch(printer, event);
		this.emit('update', id);
	}

	private dispatch(printer: BambuPrinter, event: LabEvent) {
		const id = printer.id;
		if (event.name === 'printer.offline') {
			clearTimeout(this.offline.get(id));
			const data = event.data as LabEvent<'printer.offline'>['data'];
			const timer = setTimeout(() => {
				this.offline.delete(id);
				if (printer.connected || this.connections.get(id) !== printer) return;
				this.reportedOffline.add(id);
				this.bus.emit('printer.offline', {
					printerId: id,
					printerName: printer.name,
					error: printer.error || data.error
				});
			}, this.options.offlineAfterMs ?? 10_000);
			timer.unref?.();
			this.offline.set(id, timer);
			return;
		}
		if (event.name === 'printer.online') {
			const pending = this.offline.get(id);
			clearTimeout(pending);
			this.offline.delete(id);
			// Back within the grace period: nothing happened as far as anyone needs to know.
			if (pending && !this.reportedOffline.has(id)) return;
			this.reportedOffline.delete(id);
		}
		if (event.name === 'print.started') this.printStarted.set(id, Date.now());
		const { at: _at, ...data } = event.data as unknown as Record<string, unknown>;
		if (event.name === 'print.finished') {
			const started = this.printStarted.get(id);
			data.minutes = started ? Math.max(1, Math.round((Date.now() - started) / 60_000)) : null;
		}
		this.bus.emit(event.name, data as never);
	}

	// ---------- Registry writes ----------

	private nextSortOrder() {
		return (
			(this.db
				.select({ n: max(printers.sortOrder) })
				.from(printers)
				.get()?.n ?? -1) + 1
		);
	}

	private uniqueSerial(serial: string, except?: string) {
		const other = this.db.select().from(printers).where(eq(printers.serial, serial)).get();
		if (other && other.id !== except)
			throw new AppError(
				409,
				`A printer with serial number ${serial} is already saved (“${other.name}”).`
			);
	}

	create(input: unknown): PrinterInfo {
		const data = parse(printerInput, input);
		this.uniqueSerial(data.serial);
		const id = uuid();
		const pin = this.pendingPins.get(data.serial) ?? null;
		this.pendingPins.delete(data.serial);
		this.db
			.insert(printers)
			.values({ id, ...data, tlsPin: pin, sortOrder: this.nextSortOrder() })
			.run();
		this.mayPin.add(id);
		this.lab.touch('printer', `Added the printer ${data.name}`);
		const row = this.row(id)!;
		if (row.enabled) this.connect(row);
		this.emit('changed');
		return this.infoOf(id);
	}

	update(id: string, input: unknown): PrinterInfo {
		const { version, ...data } = parse(printerPatch, input);
		if (data.accessCode === '') delete data.accessCode; // "Leave empty to keep"
		const before = this.row(id);
		if (!before) throw new AppError(404, 'That printer no longer exists.');
		if (data.serial) this.uniqueSerial(data.serial, id);
		// A different address or printer means a different certificate: trust it afresh.
		const moved =
			(data.host !== undefined && data.host !== before.host) ||
			(data.serial !== undefined && data.serial !== before.serial);
		const result = this.db
			.update(printers)
			.set({
				...data,
				...(moved && { tlsPin: null }),
				version: sql`${printers.version} + 1`,
				updatedAt: nowIso()
			})
			.where(and(eq(printers.id, id), eq(printers.version, version)))
			.run();
		if (result.changes === 0)
			throw new AppError(409, 'This printer was changed somewhere else. Reload it and try again.');
		if (moved) this.mayPin.add(id);
		this.lab.touch(
			'printer',
			data.name && data.name !== before.name
				? `Renamed the printer ${before.name} to ${data.name}`
				: undefined
		);
		const row = this.row(id)!;
		const reconnect = CONNECTION_FIELDS.some((f) => data[f] !== undefined && data[f] !== before[f]);
		if (!row.enabled) this.disconnect(id);
		else if (reconnect || !this.connections.has(id) || moved) this.connect(row);
		else if (data.name) {
			const live = this.connections.get(id)!;
			live.config.name = row.name;
			this.onUpdate(live);
		}
		this.emit('changed');
		return this.infoOf(id);
	}

	remove(id: string): void {
		const row = this.row(id);
		if (!row) throw new AppError(404, 'That printer no longer exists.');
		this.disconnect(id);
		// Jobs keep their history: the foreign key sets their printer to "any".
		this.db.delete(printers).where(eq(printers.id, id)).run();
		this.lab.touch('printer', `Removed the printer ${row.name}`);
		this.emit('changed');
	}

	reorder(ids: string[]): void {
		const { ids: order } = parse(printerReorder, { ids });
		const known = new Set(this.rows().map((r) => r.id));
		this.db.transaction((tx) => {
			order
				.filter((id) => known.has(id))
				.forEach((id, i) =>
					tx.update(printers).set({ sortOrder: i }).where(eq(printers.id, id)).run()
				);
		});
		this.lab.touch('printer');
		this.emit('changed');
	}

	/** "Trust the new certificate": forget the pin and pin whatever the printer presents next. */
	trust(id: string): PrinterInfo {
		const row = this.row(id);
		if (!row) throw new AppError(404, 'That printer no longer exists.');
		this.db.update(printers).set({ tlsPin: null }).where(eq(printers.id, id)).run();
		this.mayPin.add(id);
		this.lab.touch('printer', `Trusting the new certificate of ${row.name}`);
		if (row.enabled) this.connect(this.row(id)!);
		return this.infoOf(id);
	}

	/**
	 * Connects with the given settings without saving (a person pressed Test, so an unknown
	 * certificate may be pinned): waits for the first report and the firmware versions, 10 s at most.
	 */
	async test(input: unknown): Promise<{
		ok: boolean;
		ms: number;
		detail: string;
		model: ModelCode | null;
		firmware: string | null;
	}> {
		const { id, ...data } = parse(printerTest, input);
		const saved = id ? this.row(id) : undefined;
		if (id && !saved) throw new AppError(404, 'That printer no longer exists.');
		const accessCode = data.accessCode || saved?.accessCode;
		if (!accessCode) throw new AppError(400, 'Enter the access code shown on the printer.');
		const samePrinter = saved && saved.serial === data.serial && saved.host === data.host;
		const started = performance.now();
		const probe = new BambuPrinter(
			{
				id: id ?? 'test',
				model: data.model,
				host: data.host,
				serial: data.serial,
				accessCode,
				name: data.name ?? 'Printer',
				port: data.port,
				ftpPort: data.ftpPort,
				useTls: data.tls,
				simulated: data.simulated,
				tlsPin: samePrinter ? saved!.tlsPin : null
			},
			{
				mayPin: true,
				ca: this.options.ca,
				onPin: (pin) => {
					if (samePrinter) this.savePin(saved!.id, pin);
					else this.pendingPins.set(data.serial, pin);
				}
			}
		);
		const ms = () => Math.round(performance.now() - started);
		try {
			const ok = await new Promise<boolean>((resolve) => {
				const done = (v: boolean) => {
					clearTimeout(timer);
					probe.off('update', check);
					resolve(v);
				};
				const check = () => {
					if (probe.snapshot && probe.versions.length) done(true);
					// Refused (wrong access code, certificate): no point waiting for the retry.
					else if (!probe.connected && probe.error) done(false);
				};
				const timer = setTimeout(() => done(!!probe.snapshot), 10_000);
				probe.on('update', check);
				probe.start();
			});
			const firmware = firmwareVersion(probe.versions);
			const found = detectModel({ modules: probe.versions });
			if (!ok)
				return {
					ok: false,
					ms: ms(),
					detail:
						probe.error ||
						(probe.connected
							? 'The printer accepted the connection but sent no status. Is Developer Mode on?'
							: 'No answer within 10 seconds. Check the IP address and that the printer is on.'),
					model: found,
					firmware
				};
			const s = probe.snapshot!;
			return {
				ok: true,
				ms: ms(),
				detail: [
					`Connected${probe.trust === 'pinned' ? ' (certificate trusted on first use)' : probe.trust === 'ca' ? ' (certificate verified)' : ''}`,
					found ? `it is a ${PRINTER_MODELS[found].short}` : null,
					firmware ? `firmware ${firmware}` : null,
					s.developerMode === false
						? 'Developer Mode is off, so the app can only watch this printer'
						: null
				]
					.filter(Boolean)
					.join(', ')
					.concat('.'),
				model: found,
				firmware
			};
		} finally {
			probe.stop();
		}
	}

	async discoverDetailed(o: { ms?: number; port?: number } = {}) {
		const known = new Set(this.rows().map((r) => r.serial.toUpperCase()));
		const { printers: found, warning } = await discoverPrinters(o);
		this.discoveryWarning = warning;
		return {
			printers: found.map((p) => ({ ...p, known: known.has(p.serial.toUpperCase()) })),
			...(warning && { warning })
		};
	}

	async discover(ms?: number): Promise<DiscoveredPrinter[]> {
		return (await this.discoverDetailed({ ms })).printers;
	}

	/** The warning from the last discovery (port in use…), if any. */
	get lastDiscoveryWarning() {
		return this.discoveryWarning;
	}

	/** The redacted raw report and versions of one printer, for "Download diagnostics". */
	diagnostics(id: string) {
		const p = this.require(id);
		return {
			source: 'Family Print Lab diagnostics (redacted)',
			capturedAt: nowIso(),
			firmware: p.firmware,
			...p.rawReport()
		};
	}

	// ---------- Imports ----------

	/** The old BAMBU_* settings become one saved printer, once (4.2.1 of the parity plan). */
	private importEnv() {
		const env = this.options.env;
		if (this.db.select().from(meta).where(eq(meta.key, ENV_IMPORTED)).get()) return;
		const { BAMBU_HOST: host, BAMBU_SERIAL: rawSerial, BAMBU_ACCESS_CODE: accessCode } = env;
		if (!host || !rawSerial || !accessCode) return;
		const serial = rawSerial.trim().toUpperCase();
		const model: ModelCode = isModelCode(env.BAMBU_MODEL)
			? env.BAMBU_MODEL
			: // The app has only ever targeted the X2D.
				(detectModel({ productName: env.BAMBU_NAME }) ?? 'N6');
		const exists = this.db.select().from(printers).where(eq(printers.serial, serial)).get();
		if (!exists) {
			const id = uuid();
			this.db
				.insert(printers)
				.values({
					id,
					name: (env.BAMBU_NAME || PRINTER_MODELS[model].name).slice(0, 60),
					model,
					host,
					serial,
					accessCode,
					port: Number(env.BAMBU_PORT) || 8883,
					ftpPort: Number(env.BAMBU_FTP_PORT) || 990,
					tls: env.BAMBU_TLS !== 'off',
					simulated: env.BAMBU_SIMULATED === '1',
					sortOrder: this.nextSortOrder()
				})
				.run();
			// The person put these details in themselves: the first connection may pin the certificate.
			this.mayPin.add(id);
			this.options.log(`Printers: imported ${serial} from the BAMBU_* settings`);
		}
		this.db.insert(meta).values({ key: ENV_IMPORTED, value: nowIso() }).onConflictDoNothing().run();
		this.lab.touch('printer');
	}

	/** PRINTLAB_PRINTERS (a JSON list, used by dev:sim and tests for fleets): upserted by serial on every boot. */
	private importFleet() {
		const raw = this.options.env.PRINTLAB_PRINTERS;
		if (!raw) return;
		let list: unknown;
		try {
			list = JSON.parse(raw);
		} catch {
			return this.options.log('PRINTLAB_PRINTERS is not valid JSON; ignored.');
		}
		if (!Array.isArray(list)) return;
		for (const item of list.slice(0, 50)) {
			let data;
			try {
				data = parse(printerInput, { enabled: true, ...(item as object) });
			} catch (error) {
				this.options.log(`PRINTLAB_PRINTERS: skipped one (${(error as Error).message})`);
				continue;
			}
			const existing = this.db
				.select()
				.from(printers)
				.where(eq(printers.serial, data.serial))
				.get();
			const { enabled: _enabled, ...fields } = data;
			if (existing)
				this.db
					.update(printers)
					.set({ ...fields, updatedAt: nowIso() })
					.where(eq(printers.id, existing.id))
					.run();
			else
				this.db
					.insert(printers)
					.values({ id: uuid(), ...data, sortOrder: this.nextSortOrder() })
					.run();
		}
		this.lab.touch('printer');
	}
}
