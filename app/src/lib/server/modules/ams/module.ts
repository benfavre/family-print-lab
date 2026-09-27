// AMS and spool inventory sync: keeps tray ↔ spool links in step with what each printer reports
// (RFID spools link by themselves), charges finished and failed prints to the spools in the trays they
// used, and optionally mirrors usage to Spoolman. Routes: /api/printers/[id]/ams/*, /api/spoolman/*.
import { defineModule, type ModuleContext } from '../../modules';
import type { SpoolSyncService } from '../contracts';
import { AppError } from '../../validation';
import { AmsStore, type ChargeResult } from './store';
import { progressFraction } from './charges';
import {
	SpoolmanClient,
	shelfSpoolFrom,
	spoolmanBase,
	spoolmanRemaining,
	type SpoolmanSpool
} from './spoolman';
import {
	SPOOLMAN_DEFAULTS,
	spoolmanInput,
	spoolmanSettings,
	type SpoolmanSettings
} from './validation';
import {
	allTrays,
	remainDisagreement,
	type AmsOptions,
	type AmsState,
	type SpoolmanView
} from '$lib/shared/ams';
import type { GlobalTray, PrinterTray } from '$lib/shared/printers/status';
import type { SettingsStore } from '../../module-settings';
import type { Raw } from '../../printer/report';
import { parse } from '../../validation';

export interface AmsService extends SpoolSyncService {
	store: AmsStore;
	state(printerId: string): AmsState;
	/** The tray as the printer reports it now (404/409 in words when it is not there). */
	tray(printerId: string, tray: GlobalTray): PrinterTray;
	link(printerId: string, tray: GlobalTray, spoolId: string): void;
	unlink(printerId: string, tray: GlobalTray): void;
	addFromTray(printerId: string, tray: GlobalTray): string;
	/** Takes the printer's remaining estimate for the RFID spool in a tray. */
	reconcile(printerId: string, tray: GlobalTray): void;
	/** Charges a job now (the bus does this on print.finished / print.failed). */
	charge(jobId: string, fraction: number): ChargeResult | null;
	spoolman: {
		view(): SpoolmanView;
		save(input: unknown): SpoolmanView;
		test(): Promise<string>;
		import(): Promise<{ added: number; skipped: number }>;
		pull(): Promise<{ updated: number }>;
	};
}

declare module '../../modules' {
	interface ModuleServices {
		ams: AmsService;
	}
}

declare module '../../events' {
	interface LabEventMap {
		/** A print was charged to the spools in the trays it used. */
		'spool.charged': {
			printerId: string;
			jobId: string;
			charges: { spoolId: string; tray: GlobalTray; grams: number }[];
		};
		/** A tray link was made (spoolId) or dropped (null). */
		'spool.linked': { printerId: string; tray: GlobalTray; spoolId: string | null };
		/** A charge took a spool under 15 % or 100 g. */
		'spool.low': { spoolId: string; name: string; remainingGrams: number; totalGrams: number };
	}
}

const isLow = (remaining: number, total: number) => remaining / total < 0.15 || remaining < 100;

/** The AMS reading options from the merged report (Bambu Studio DevFilaSystem.cpp ~535). */
export function readAmsOptions(ams: Raw | undefined): AmsOptions | null {
	if (!ams || typeof ams !== 'object') return null;
	const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);
	const o = {
		startupRead: flag(ams.power_on_flag),
		trayRead: flag(ams.insert_flag),
		remainCalibrate: flag(ams.calibrate_remain_flag)
	};
	return Object.values(o).every((v) => v === null) ? null : o;
}

function createService(ctx: ModuleContext): AmsService & { stop(): void } {
	const store = new AmsStore(ctx.db, ctx.lab);
	const settings: SettingsStore<SpoolmanSettings> = ctx.settings(
		spoolmanSettings,
		SPOOLMAN_DEFAULTS
	);
	let lastError: string | null = null;
	const fingerprints = new Map<string, string>();
	const progress = new Map<string, { layer: number; totalLayers: number | null }>();
	/** Each printer's tray links when its current print started. */
	const startLinks = new Map<string, Map<GlobalTray, string>>();

	const snapshot = (printerId: string) => ctx.printers.get(printerId)?.snapshot ?? null;
	const announce = (printerId: string) => ctx.live.send('ams:links', { printerId });

	function tray(printerId: string, global: GlobalTray): PrinterTray {
		ctx.printers.statusOf(printerId);
		const s = snapshot(printerId);
		if (!s) throw new AppError(409, 'The printer has not reported its trays yet.');
		const t = allTrays(s).find((x) => x.global === global);
		if (!t) throw new AppError(404, 'That tray is not on this printer.');
		return t;
	}

	/** Re-checks a printer's links whenever its trays change. */
	function sync(printerId: string) {
		const s = snapshot(printerId);
		if (!s) return;
		const trays = allTrays(s);
		const print = JSON.stringify(
			trays.map((t) => [t.global, t.type, t.color, t.trayUuid, t.tagUid, t.remain])
		);
		if (fingerprints.get(printerId) === print) return;
		fingerprints.set(printerId, print);
		// Every printer's links: an RFID spool that turns up here leaves the tray it had elsewhere.
		const key = (l: { printerId: string; tray: number }) => `${l.printerId}\u0000${l.tray}`;
		const before = new Map(store.links().map((l) => [key(l), l]));
		if (!store.sync(printerId, trays)) return;
		const after = new Map(store.links().map((l) => [key(l), l]));
		const touched = new Set<string>();
		for (const k of new Set([...before.keys(), ...after.keys()])) {
			const was = before.get(k);
			const now = after.get(k);
			if (was?.spoolId === now?.spoolId) continue;
			const where = (now ?? was)!;
			touched.add(where.printerId);
			ctx.bus.emit('spool.linked', {
				printerId: where.printerId,
				tray: where.tray,
				spoolId: now?.spoolId ?? null
			});
		}
		for (const id of touched) announce(id);
	}

	function spoolmanClient(): SpoolmanClient {
		const s = settings.get();
		if (!s.enabled || !s.url)
			throw new AppError(409, 'Turn on Spoolman and give its address first.');
		return new SpoolmanClient(s.url, s.token);
	}

	/** Mirrors a charge to Spoolman (fire and forget; the error is shown in its settings). */
	function pushUsage(charges: { spoolId: string; grams: number }[]) {
		const s = settings.get();
		if (!s.enabled || !s.url || !s.pushUsage) return;
		const client = new SpoolmanClient(s.url, s.token);
		for (const c of charges) {
			const spoolmanId = store.spool(c.spoolId)?.spoolmanId;
			if (!spoolmanId || !(c.grams > 0)) continue;
			client.use(spoolmanId, c.grams).then(
				() => (lastError = null),
				(error: Error) => {
					lastError = `Could not record ${c.grams} g in Spoolman: ${error.message}`;
					ctx.log(lastError);
				}
			);
		}
	}

	function charge(jobId: string, fraction: number, atStart?: Map<GlobalTray, string>) {
		const result = store.chargeJob(jobId, fraction, atStart);
		if (!result) {
			// Lab's single-spool path paid for it (a job not sent from the app, or no tray linked).
			const job = ctx.lab.getJob(jobId);
			if (job?.chargeSpoolId && job.chargeGrams > 0)
				pushUsage([{ spoolId: job.chargeSpoolId, grams: job.chargeGrams }]);
			return null;
		}
		if (result.charges.length) ctx.bus.emit('spool.charged', result);
		for (const c of result.charges) {
			const spool = store.spool(c.spoolId);
			if (!spool) continue;
			const before = spool.remainingGrams + c.grams;
			if (isLow(spool.remainingGrams, spool.totalGrams) && !isLow(before, spool.totalGrams))
				ctx.bus.emit('spool.low', {
					spoolId: spool.id,
					name: [spool.colorName, spool.material].filter(Boolean).join(' '),
					remainingGrams: spool.remainingGrams,
					totalGrams: spool.totalGrams
				});
		}
		pushUsage(result.charges);
		return result;
	}

	const onUpdate = (id: string) => {
		try {
			sync(id);
		} catch (error) {
			ctx.log(`Tray sync failed: ${(error as Error).message}`);
		}
	};
	ctx.printers.on('update', onUpdate);
	const offs = [
		ctx.bus.on('print.started', (d) => {
			progress.delete(d.printerId);
			startLinks.set(
				d.printerId,
				new Map(store.links(d.printerId).map((l) => [l.tray, l.spoolId]))
			);
		}),
		ctx.bus.on('print.layer', (d) =>
			progress.set(d.printerId, { layer: d.layer, totalLayers: d.totalLayers })
		),
		ctx.bus.on('print.finished', (d) => {
			const atStart = startLinks.get(d.printerId);
			progress.delete(d.printerId);
			startLinks.delete(d.printerId);
			if (d.jobId) charge(d.jobId, 1, atStart);
		}),
		ctx.bus.on('print.failed', (d) => {
			const seen = progress.get(d.printerId);
			const atStart = startLinks.get(d.printerId);
			progress.delete(d.printerId);
			startLinks.delete(d.printerId);
			if (!d.jobId) return;
			const s = snapshot(d.printerId);
			charge(
				d.jobId,
				progressFraction({
					layer: s?.layer || seen?.layer,
					totalLayers: s?.totalLayers || seen?.totalLayers,
					percent: s?.percent
				}),
				atStart
			);
		})
	];
	// Printers already reporting when the module starts.
	for (const p of ctx.printers.list()) onUpdate(p.id);

	const view = (): SpoolmanView => {
		const s = settings.get();
		return {
			enabled: s.enabled,
			url: s.url,
			hasToken: !!s.token,
			pushUsage: s.pushUsage,
			lastError,
			imported: store.spools().filter((x) => x.spoolmanId !== null && x.spoolmanId !== undefined)
				.length
		};
	};

	return {
		store,
		spoolForTray: (printerId, t) => store.spoolForTray(printerId, t),
		state(printerId) {
			ctx.printers.statusOf(printerId);
			let options: AmsOptions | null;
			try {
				// Last resort (PLAN 7.2): the reading options are not in the typed snapshot.
				options = readAmsOptions(ctx.printers.get(printerId)?.rawReport().pushall.ams as Raw);
			} catch {
				options = null;
			}
			return { printerId, links: store.links(printerId), options };
		},
		tray,
		link(printerId, t, spoolId) {
			store.link(printerId, tray(printerId, t), spoolId);
			ctx.bus.emit('spool.linked', { printerId, tray: t, spoolId });
			announce(printerId);
		},
		unlink(printerId, t) {
			ctx.printers.statusOf(printerId);
			const s = snapshot(printerId);
			const now = s ? allTrays(s).find((x) => x.global === t) : undefined;
			if (store.unlink(printerId, now, t)) {
				ctx.bus.emit('spool.linked', { printerId, tray: t, spoolId: null });
				announce(printerId);
			}
		},
		addFromTray(printerId, t) {
			const id = store.addFromTray(printerId, tray(printerId, t));
			ctx.bus.emit('spool.linked', { printerId, tray: t, spoolId: id });
			announce(printerId);
			return id;
		},
		reconcile(printerId, t) {
			const link = store.linkFor(printerId, t);
			const spool = link && store.spool(link.spoolId);
			if (!spool) throw new AppError(404, 'No spool is linked to that tray.');
			const differ = remainDisagreement(tray(printerId, t), spool);
			if (!differ) throw new AppError(409, 'The printer and the shelf already agree.');
			ctx.lab.updateSpool(spool.id, {
				version: spool.version,
				remainingGrams: differ.printerGrams
			});
		},
		charge,
		spoolman: {
			view,
			save(input) {
				const o = parse(spoolmanInput, input);
				const now = settings.get();
				const url = o.url ? spoolmanBase(o.url) : '';
				if (o.enabled && !url) throw new AppError(400, 'Give Spoolman’s address to turn it on.');
				// The saved token only ever goes to the address it was given for: a new address needs
				// it typed again, so changing the address cannot send the old token somewhere else.
				const keep = !o.clearToken && (!url || url === now.url);
				settings.set({
					enabled: o.enabled,
					url,
					token: o.token || (keep ? now.token : ''),
					pushUsage: o.pushUsage
				});
				lastError = null;
				return view();
			},
			async test() {
				const info = await spoolmanClient().info();
				lastError = null;
				return info.version
					? `Spoolman ${String(info.version).slice(0, 20)} answered.`
					: 'Spoolman answered.';
			},
			async import() {
				const remote = await spoolmanClient().spools();
				const known = new Set(store.spools().map((s) => s.spoolmanId));
				let added = 0;
				let skipped = 0;
				for (const s of remote as SpoolmanSpool[]) {
					if (s.archived || known.has(s.id)) {
						skipped++;
						continue;
					}
					const id = ctx.lab.createSpool(shelfSpoolFrom(s));
					store.setSpoolmanId(id, s.id);
					added++;
				}
				lastError = null;
				return { added, skipped };
			},
			async pull() {
				const remote = new Map((await spoolmanClient().spools()).map((s) => [s.id, s]));
				let updated = 0;
				for (const spool of store.spools()) {
					const r = spool.spoolmanId ? remote.get(spool.spoolmanId) : undefined;
					const grams = r ? spoolmanRemaining(r) : null;
					if (grams === null) continue;
					const value = Math.round(Math.min(spool.totalGrams, grams) * 10) / 10;
					if (Math.abs(value - spool.remainingGrams) < 0.5) continue;
					ctx.lab.updateSpool(spool.id, { version: spool.version, remainingGrams: value });
					updated++;
				}
				lastError = null;
				return { updated };
			}
		},
		stop() {
			ctx.printers.off('update', onUpdate);
			for (const off of offs) off();
		}
	};
}

// One per runtime (tests may boot several one after another); the newest answers integrations().
const running: ReturnType<typeof createService>[] = [];

export default defineModule({
	key: 'ams',
	order: 40,
	start(ctx): AmsService {
		const service = createService(ctx);
		running.push(service);
		return service;
	},
	stop() {
		running.pop()?.stop();
	},
	integrations() {
		const v = running.at(-1)?.spoolman.view();
		if (!v) return [];
		const ready = v.enabled && !!v.url;
		return [
			{
				id: 'spoolman',
				kind: 'module' as const,
				name: 'Spoolman',
				via: 'Your own Spoolman server',
				available: ready && !v.lastError,
				detail: !ready
					? 'Off. Nothing is sent until you turn it on.'
					: v.lastError
						? v.lastError
						: `On: ${v.imported} spool${v.imported === 1 ? '' : 's'} from Spoolman.`,
				powers: ready
					? ['Importing spools', ...(v.pushUsage ? ['Recording what each print used'] : [])]
					: [],
				setup: [
					{ text: 'Run Spoolman on your network (see its README on GitHub).' },
					{ text: 'Integrations → Spoolman: give its address and turn it on.' }
				]
			}
		];
	}
});
