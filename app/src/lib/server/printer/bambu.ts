// One connection to a Bambu Lab printer in LAN-only + Developer Mode: its local MQTT broker (reports on
// device/<serial>/report, commands on device/<serial>/request) and its FTPS file service. Reports go
// through report.ts (merge + parse); commands go through the typed command layer (commands/). The
// PrinterManager owns one of these per saved printer and turns status changes into bus events.
import { EventEmitter } from 'node:events';
import type tls from 'node:tls';
import { MqttClient } from './mqtt';
import { uploadFile } from './ftp';
import { firmwareVersion, mergeReport, parseReport, parseVersions, type Raw } from './report';
import { printerTlsOptions, verifyPrinterCert } from './tls';
import {
	commandDef,
	replyFailed,
	type CommandContext,
	type CommandMap,
	type CommandName,
	type CommandOutcome
} from './commands/registry';
import type { ProjectFileParams } from './commands/defs/core';
import { AppError, parse } from '../validation';
import {
	PRINTER_MODELS,
	capabilitiesFor,
	detectModel,
	modelShort,
	type CameraProtocol,
	type ModelCode,
	type PrinterModel
} from '$lib/shared/printers/models';
import {
	ACTIVE_PRINTER_STATES,
	type PrinterSnapshot,
	type PrinterStatus,
	type VersionModule
} from '$lib/shared/printers/status';

export type { ProjectFileParams };
/** @deprecated The old name of print.project_file's params. */
export type StartOptions = ProjectFileParams;
export type PrintControl = 'pause' | 'resume' | 'stop';

export interface PrinterConfig {
	id: string;
	model: ModelCode;
	host: string;
	serial: string;
	accessCode: string;
	name?: string;
	port?: number;
	/** File service port: 990 (implicit FTPS) on the printer. */
	ftpPort?: number;
	useTls?: boolean;
	simulated?: boolean;
	enabled?: boolean;
	/** SHA-256 of the printer's certificate when it was trusted on first use (tls.ts). */
	tlsPin?: string | null;
}

export interface ConnectionOptions {
	/**
	 * This connection was started by the person (Add, Test, the env import), so an unknown certificate
	 * chain may be trusted on first use and pinned.
	 */
	mayPin?: boolean;
	/** Called with the fingerprint to store when a certificate is pinned. */
	onPin?: (fingerprint: string) => void;
	/** CA certificates instead of the bundled Bambu ones (tests). */
	ca?: (string | Buffer)[];
	log?: (message: string) => void;
}

const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

export const DEVELOPER_MODE_OFF =
	'Developer Mode is off on the printer, so it ignores commands from this app. Turn it on in the printer’s network settings.';
/**
 * OpenBambuAPI mqtt.md "pushing.pushall": a rule of thumb of not polling more often than every 5 minutes
 * on printers that send deltas; it holds for the watchdog's periodic asks, not for a reconnect.
 */
const PUSHALL_MIN_MS = 5 * 60_000;
/** Bambu Studio DeviceManager.hpp REQUEST_PUSH_MIN_TIME: never twice within 3 s, even when forced. */
const PUSHALL_FLOOR_MS = 3000;
/** Re-read firmware versions this often. */
const VERSION_EVERY_MS = 6 * 3600_000;
/** No message for this long while connected: ask for everything, then reconnect after STALE_CLOSE_MS more. */
const STALE_MS = 60_000;
const STALE_CLOSE_MS = 30_000;

/** Turns a raw `print` report into a snapshot (older call sites and tests). */
export function summarize(p: Raw = {}, model: ModelCode = 'N6'): PrinterSnapshot {
	return parseReport(mergeReport({}, p), {
		model: PRINTER_MODELS[model],
		versions: [],
		accessCodeSet: true
	});
}

/** What the printer answered to a command (any topic). */
interface Reply {
	topic: string;
	command: string;
	sequence: string;
	body: Raw;
}

/** Emits 'update' on every status change, 'reply' for command answers, 'log' for mc_print push_info lines. */
export class BambuPrinter extends EventEmitter {
	readonly model: PrinterModel;
	private raw: Raw = {};
	private current: PrinterSnapshot | null = null;
	private client: MqttClient | null = null;
	private timer?: NodeJS.Timeout;
	private versionTimer?: NodeJS.Timeout;
	private watchdog?: NodeJS.Timeout;
	private pushallTimer?: NodeJS.Timeout;
	private retry = 0;
	private stopped = true;
	private lastMessage = 0;
	private lastPushall = 0;
	private staleSince = 0;
	private sequence = 20000 + Math.floor(Math.random() * 10000);
	versions: VersionModule[] = [];
	connected = false;
	lastSeen: string | null = null;
	error = '';
	warning = '';
	trust: 'ca' | 'pinned' | null = null;

	constructor(
		readonly config: PrinterConfig,
		private options: ConnectionOptions = {}
	) {
		super();
		this.model = PRINTER_MODELS[config.model] ?? PRINTER_MODELS.N6;
		// One listener per open tab (live events) plus in-flight commands.
		this.setMaxListeners(200);
	}

	get id() {
		return this.config.id;
	}

	get name() {
		return this.config.name || this.model.name;
	}

	/** The parsed status (unredacted: server code only). */
	get snapshot(): PrinterSnapshot | null {
		return this.current;
	}

	get firmware(): string | null {
		return firmwareVersion(this.versions);
	}

	start() {
		if (!this.stopped) return this;
		this.stopped = false;
		this.open();
		this.watchdog = setInterval(() => this.checkStale(), 10_000);
		this.watchdog.unref?.();
		return this;
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		clearInterval(this.versionTimer);
		clearInterval(this.watchdog);
		clearTimeout(this.pushallTimer);
		this.client?.end();
	}

	private log(message: string) {
		this.options.log?.(`${this.name}: ${message}`);
	}

	private open() {
		const { host, port = 8883, useTls = true, serial, accessCode, simulated } = this.config;
		// Simulated printers and plain connections skip the certificate check (tls.ts).
		const verifyTls = useTls && !simulated;
		const client = new MqttClient({
			host,
			port,
			useTls,
			clientId: `print-lab-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
			username: 'bblp',
			password: accessCode,
			tlsOptions: verifyTls
				? printerTlsOptions(serial, this.options.ca)
				: { rejectUnauthorized: false, maxVersion: 'TLSv1.2' },
			verify: verifyTls ? (socket) => this.verify(socket) : undefined
		});
		this.client = client;
		client.on('connect', () => {
			this.connected = true;
			this.error = '';
			this.retry = 0;
			this.lastMessage = Date.now();
			this.staleSince = 0;
			client.subscribe(`device/${serial}/report`);
			// Everything on every connect: deltas sent while the connection was down are never repeated,
			// so the merged report is stale until a full one arrives (ha-bambulab bambu_client.py
			// _on_connect → subscribe_and_request_info publishes PUSH_ALL each time). Then versions (and
			// again every 6 hours).
			this.pushallOnConnect();
			this.requestVersions();
			clearInterval(this.versionTimer);
			this.versionTimer = setInterval(() => this.requestVersions(), VERSION_EVERY_MS);
			this.versionTimer.unref?.();
			this.emit('update');
		});
		client.on('message', (_topic: string, payload: Buffer) => this.receive(payload));
		client.on('error', (error: NodeJS.ErrnoException) => (this.error = friendly(error)));
		client.on('close', () => {
			this.connected = false;
			clearInterval(this.versionTimer);
			this.emit('update');
			if (this.stopped) return;
			const delay = Math.min(60_000, 2000 * 2 ** this.retry++);
			this.timer = setTimeout(() => this.open(), delay);
		});
		client.connect();
	}

	/** The TLS policy (tls.ts), run before the access code is sent. */
	private verify(socket: tls.TLSSocket): string | null {
		const result = verifyPrinterCert(socket, {
			serial: this.config.serial,
			pin: this.config.tlsPin ?? null,
			mayPin: this.options.mayPin
		});
		if (!result.ok) {
			this.trust = null;
			return result.error;
		}
		this.trust = result.trust;
		// One accepted certificate ends trust on first use for this printer (PLAN 4.2.3), including
		// after a CA-verified one, whose leaf is pinned as well (tls.ts).
		this.options.mayPin = false;
		if (result.pin) {
			this.config.tlsPin = result.pin;
			this.options.onPin?.(result.pin);
			this.log(
				result.trust === 'ca'
					? 'certificate verified by the Bambu CA and remembered'
					: 'certificate trusted on first use'
			);
		}
		return null;
	}

	/** Allows pinning a new certificate on the next connection (Settings: "Trust the new certificate"). */
	trustNextCertificate() {
		this.config.tlsPin = null;
		this.options.mayPin = true;
	}

	private checkStale() {
		if (!this.connected || !this.client) return;
		const quiet = Date.now() - this.lastMessage;
		if (quiet < STALE_MS) return;
		if (!this.staleSince) {
			// A printer that sends deltas may just have nothing to say: only a pushall it leaves
			// unanswered makes the connection stale, and pushall waits its 5 minutes.
			if (this.requestPushall(false)) this.staleSince = Date.now();
		} else if (Date.now() - this.staleSince >= STALE_CLOSE_MS) {
			this.log('no reports for a while, reconnecting');
			this.staleSince = 0;
			this.client.end();
		}
	}

	/** A forced pushall now, or as soon as the 3 s floor allows (a quick reconnect must not skip it). */
	private pushallOnConnect() {
		clearTimeout(this.pushallTimer);
		if (this.requestPushall(true)) return;
		this.pushallTimer = setTimeout(
			// Timers may fire a millisecond early: try again (it reschedules if the floor still holds).
			() => this.connected && this.pushallOnConnect(),
			PUSHALL_FLOOR_MS - (Date.now() - this.lastPushall)
		);
		this.pushallTimer.unref?.();
	}

	/** Asks for a full report; false when the 5-minute rule for delta printers (or the 3 s floor) says not yet. */
	private requestPushall(force: boolean) {
		const since = Date.now() - this.lastPushall;
		if (since < PUSHALL_FLOOR_MS) return false;
		if (!force && this.model.reports === 'delta' && since < PUSHALL_MIN_MS) return false;
		this.lastPushall = Date.now();
		void this.send('pushing.pushall', {}).catch(() => {});
		return true;
	}

	private requestVersions() {
		void this.send('info.get_version', {}).catch(() => {});
	}

	private receive(payload: Buffer) {
		let message: Raw;
		try {
			message = JSON.parse(payload.toString('utf8'));
		} catch {
			return;
		}
		if (!isObject(message)) return;
		this.lastMessage = Date.now();
		this.staleSince = 0;
		let changed = false;
		for (const [topic, body] of Object.entries(message)) {
			if (!isObject(body)) continue;
			const command = text(body.command, 40);
			if (topic === 'print' && (!command || command === 'push_status')) {
				mergeReport(this.raw, body);
				changed = true;
				continue;
			}
			if (topic === 'mc_print' && command === 'push_info') {
				this.emit('log', text(body.param, 1000));
				continue;
			}
			if (topic === 'info' && command === 'get_version') {
				this.versions = parseVersions(body);
				this.checkModel();
				changed = true;
			}
			if (command)
				this.emit('reply', {
					topic,
					command,
					sequence: text(body.sequence_id ?? body.sequenceId, 40),
					body
				} satisfies Reply);
		}
		if (!changed) return;
		this.current = parseReport(this.raw, {
			model: this.model,
			versions: this.versions,
			accessCodeSet: !!this.config.accessCode
		});
		this.lastSeen = new Date().toISOString();
		this.current.lastReportAt = this.lastSeen;
		this.emit('update');
	}

	/** Says so when the printer names another model than the one saved in Settings. */
	private checkModel() {
		const found = detectModel({ modules: this.versions });
		this.warning =
			found && found !== this.config.model && !(found === 'O1C2' && this.config.model === 'O1C')
				? `This printer says it is a ${modelShort(found)}, but Settings say ${modelShort(this.config.model)}. Change the model in Settings → Printers.`
				: '';
	}

	private context(): CommandContext {
		return {
			printerId: this.id,
			model: this.model,
			caps: capabilitiesFor(this.model.code, this.firmware),
			status: this.current,
			firmware: this.firmware
		};
	}

	private nextSequence() {
		// Decimal strings in 20000–29999, like Bambu Studio (STUDIO_START_SEQ_ID); AMS commands hang
		// with ids above 2^31-1 (ClusterM research/06.02-mqtt.md).
		this.sequence = this.sequence >= 29999 ? 20000 : this.sequence + 1;
		return String(this.sequence);
	}

	/**
	 * Runs a typed command (commands/registry.ts): validates params, checks the connection, Developer
	 * Mode, capabilities and the command's own guard, publishes it, then waits for the printer's
	 * answer or for live status to show the effect. Resolves 'sent' when the printer stays silent
	 * (some firmware never answers); rejects with an AppError the UI can show.
	 */
	async send<N extends CommandName>(
		name: N,
		params: CommandMap[N] | Record<string, unknown>,
		o: { signal?: AbortSignal } = {}
	): Promise<CommandOutcome> {
		const def = commandDef(name);
		if (!def) throw new AppError(400, `Unknown printer command “${String(name).slice(0, 60)}”.`);
		const parsed = parse(def.params, params ?? {});
		const client = this.client;
		if (!client || !this.connected) throw new AppError(409, 'The printer is not connected.');
		const internal = def.topic === 'pushing' || def.topic === 'info';
		if (!internal && this.current?.developerMode === false)
			throw new AppError(409, DEVELOPER_MODE_OFF);
		const ctx = this.context();
		const missing = (def.requires ?? []).filter((cap) => !ctx.caps[cap]);
		if (missing.length)
			throw new AppError(409, `The ${this.model.short} cannot do that (${missing.join(', ')}).`);
		const refused = def.guard?.(ctx, parsed as never);
		if (refused) throw new AppError(409, refused);
		const body = def.build(parsed as never, ctx);
		const command = String(body.command);
		const sequence = this.nextSequence();
		const topic = `device/${this.config.serial}/request`;
		const message = { [def.topic]: { sequence_id: sequence, ...body } };
		if (def.reply === 'none') {
			await client.publish(topic, message, { qos: def.qos ?? 0 });
			return { outcome: 'sent' };
		}
		return new Promise<CommandOutcome>((resolve, reject) => {
			const finish = (fn: () => void) => {
				clearTimeout(timer);
				this.off('reply', onReply);
				this.off('update', onUpdate);
				client.off('close', onClose);
				o.signal?.removeEventListener('abort', onAbort);
				fn();
			};
			const onClose = () =>
				finish(() => reject(new AppError(409, 'The printer disconnected before answering.')));
			const onAbort = () => finish(() => reject(new Error('Stopped')));
			const onReply = (r: Reply) => {
				if (r.topic !== def.topic || r.command !== command) return;
				if (r.sequence && r.sequence !== sequence) return;
				const failed = replyFailed(r.body);
				if (failed)
					finish(() =>
						reject(
							new AppError(
								409,
								failed === 'fail' || failed === 'failed'
									? `The printer refused to ${command}.`
									: failed
							)
						)
					);
				else finish(() => resolve({ outcome: 'confirmed', reply: r.body }));
			};
			const onUpdate = () => {
				if (this.current && def.settled?.(this.current, parsed as never))
					finish(() => resolve({ outcome: 'confirmed' }));
			};
			const timer = setTimeout(
				() => finish(() => resolve({ outcome: 'sent' })),
				def.timeoutMs ?? 10_000
			);
			this.on('reply', onReply);
			this.on('update', onUpdate);
			client.once('close', onClose);
			o.signal?.addEventListener('abort', onAbort, { once: true });
			client
				.publish(topic, message, { qos: def.qos ?? 0 })
				.catch((error: Error) => finish(() => reject(new AppError(409, error.message))));
		});
	}

	/** Uploads a sliced file to the printer's storage, reporting progress from 0 to 1. */
	async upload(
		name: string,
		data: Buffer,
		onProgress?: (fraction: number) => void,
		signal?: AbortSignal
	) {
		const { host, accessCode, useTls = true, serial, simulated } = this.config;
		const verifyTls = useTls && !simulated;
		return uploadFile(
			{
				host,
				password: accessCode,
				useTls,
				port: this.config.ftpPort ?? (useTls ? 990 : 21),
				tls: verifyTls
					? {
							options: printerTlsOptions(serial, this.options.ca),
							verify: (socket) => this.verify(socket)
						}
					: undefined
			},
			name,
			data,
			onProgress,
			signal
		);
	}

	/** Starts printing a plate of a file already uploaded with `upload`. */
	async startPrint(o: ProjectFileParams) {
		return (await this.send('print.project_file', o)).outcome;
	}

	/** Pauses, resumes or stops the current print. */
	async control(action: PrintControl) {
		return (await this.send(`print.${action}`, {})).outcome;
	}

	/** The camera path to use now: the live report decides, else the catalogue default. */
	camera(): CameraProtocol {
		const live = this.current?.camera.lanLiveview;
		if (live === 'rtsps' || live === 'rtsp') return live;
		if (live === 'local') return 'jpeg6000';
		if (live === 'disabled') return 'none';
		return this.model.camera;
	}

	status(): PrinterStatus {
		const state = this.current;
		return {
			configured: true,
			id: this.id,
			name: this.name,
			model: this.model.code,
			modelName: this.model.name,
			caps: capabilitiesFor(this.model.code, this.firmware),
			camera: this.camera(),
			enabled: this.config.enabled ?? true,
			simulated: !!this.config.simulated,
			connected: this.connected,
			lastSeen: this.lastSeen,
			error: this.connected ? '' : this.error,
			warning:
				this.warning ||
				(this.connected && state?.developerMode === false ? DEVELOPER_MODE_OFF : ''),
			printing: !!state && ACTIVE_PRINTER_STATES.has(state.gcodeState),
			// The browser never needs the printer's own address inside the RTSP URL.
			state: state && {
				...state,
				camera: {
					...state.camera,
					rtspUrl: state.camera.rtspUrl?.replace(/^(rtsps?:\/\/)[^/]+/, '$1printer') ?? null
				}
			}
		};
	}

	/**
	 * The merged raw report with serial numbers and addresses removed, for "Download diagnostics"
	 * (in the fixtures' shape, so people with real printers can contribute test data).
	 */
	rawReport(): { model: ModelCode; pushall: Raw; get_version: Raw } {
		return {
			model: this.model.code,
			pushall: redact(structuredClone(this.raw), [
				this.config.serial,
				this.config.accessCode
			]) as Raw,
			get_version: {
				command: 'get_version',
				module: this.versions.map((m) => ({
					name: m.name,
					hw_ver: m.hw,
					sw_ver: m.sw,
					product_name: m.product,
					sn: '**REDACTED**'
				}))
			}
		};
	}
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** `secrets`: the serial number and the access code (should a report ever carry it, e.g. in a URL). */
function redact(v: unknown, secrets: string[], key = ''): unknown {
	if (Array.isArray(v)) return v.map((x) => redact(x, secrets, key));
	if (isObject(v)) {
		const out: Raw = {};
		for (const [k, x] of Object.entries(v)) out[k] = redact(x, secrets, k);
		return out;
	}
	// Serial numbers, and cloud account, task and model ids (they can identify the family).
	if (
		/^(sn|serial|dev_id|.*_sn|job_id|task_id|subtask_id|project_id|profile_id|model_id|design_id|user_id)$/i.test(
			key
		)
	)
		return typeof v === 'number' ? 0 : '**REDACTED**';
	if (key === 'ip' && typeof v === 'number') return 0;
	if (typeof v === 'string')
		return secrets
			.filter(Boolean)
			.reduce(
				(out, secret) => out.replaceAll(secret, '**REDACTED**'),
				v.replace(IPV4, '192.0.2.10')
			);
	return v;
}

function friendly(error: NodeJS.ErrnoException) {
	if (error.code === 'ECONNREFUSED')
		return 'Printer refused the connection. Check that LAN-only mode and Developer Mode are on.';
	if (error.code === 'EHOSTUNREACH' || error.code === 'ETIMEDOUT' || error.code === 'ENETUNREACH')
		return 'Printer not reachable. Check its IP address and that it is on the same network.';
	return error.message || 'Printer connection failed.';
}
