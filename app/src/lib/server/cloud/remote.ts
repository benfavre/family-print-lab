// Protocol v2 (docs/cloud-protocol.md): what the phone may see of every printer and the queue, and
// the few things it may ask for. Each part is its own switch on the Family page, all off by default:
// share status, share alerts, share queue, camera snapshots, remote control (parent PIN). With a
// phone key, status and queue travel sealed so Print Lab Cloud relays what it cannot read; commands
// must carry the phone's MAC, so a compromised cloud can relay but not forge them.
import type { EventBus } from '../events';
import type { Lab } from '../lab';
import type { ModuleServices } from '../modules';
import { AppError } from '../validation';
import { hmsKeyOf, hmsSeverity } from '$lib/shared/hms';
import type { PrinterStatus } from '$lib/shared/printers/status';
import { findFfmpeg } from '../ffmpeg';
import { fitForPhone } from './picture';
import { ReplayCache } from './replay';
import {
	CONTROL_WINDOW,
	REMOTE_ACTIONS,
	seal,
	sealSnapshot,
	verifyControlMac,
	type PhoneKeys,
	type RemoteAction
} from './phone';

export type PrinterState =
	'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'failed' | 'offline';

/** What a push can be about. The phone chooses which of these wake it. */
export type PushKind =
	'finished' | 'failed' | 'cancelled' | 'paused' | 'alert' | 'queue-started' | 'queue-held';
export interface PushEvent {
	kind: PushKind;
	/** Milliseconds since 1970; the cloud pushes each event once. */
	at: number;
}

/** One printer as the phone sees it (only with "Share printer status" on). */
export interface PrinterSummaryV2 {
	id: string;
	name: string;
	model: string;
	state: PrinterState;
	title: string;
	percent: number | null;
	remainingMinutes: number | null;
	layer: number | null;
	totalLayers: number | null;
	/** Only with "Share alerts" on. */
	hms?: { key: string; severity: string; text: string }[];
	/** Whether a snapshot can be asked for (camera present and snapshots on). */
	camera: boolean;
	event: PushEvent | null;
	/**
	 * Only with "Share queue": the queued item Start next would send to this printer now (null: none,
	 * or the plate is not confirmed clear). The phone signs this id when it asks to start it.
	 */
	next?: string | null;
}

/** A queued print as the phone sees it (only with "Share queue" on). */
export interface QueueSummary {
	id: string;
	title: string;
	printerId: string | null;
	status: string;
	/** Estimated minutes. */
	minutes: number | null;
	/** Why it has not started yet (null: it goes next). */
	waitingFor: string | null;
}

/** What the link needs from the rest of the app. Everything but the statuses is optional. */
export interface CloudHost {
	/** Every saved printer, in Settings order. */
	statuses(): PrinterStatus[];
	on(event: 'update', listener: () => void): unknown;
	off(event: 'update', listener: () => void): unknown;
	/** Sends pause, resume or stop to a printer (PrinterManager.require(id).send). */
	send?(
		printerId: string,
		command: 'print.pause' | 'print.resume' | 'print.stop'
	): Promise<unknown>;
	bus?: EventBus;
	module?<K extends keyof ModuleServices>(key: K): ModuleServices[K] | undefined;
	/** Where ffmpeg is, for making camera pictures smaller (default: the usual places). */
	ffmpeg?(): string | null;
}

export interface RemoteSettings {
	shareProgress: boolean;
	shareAlerts: boolean;
	shareQueue: boolean;
	snapshots: boolean;
	remoteControl: boolean;
}

const STATES: Record<string, PrinterState> = {
	IDLE: 'idle',
	PREPARE: 'preparing',
	SLICING: 'preparing',
	RUNNING: 'printing',
	PAUSE: 'paused',
	FINISH: 'finished',
	FAILED: 'failed'
};

export function printerState(status: PrinterStatus): PrinterState {
	const s = status.connected ? status.state : null;
	return s ? (STATES[s.gcodeState] ?? 'idle') : 'offline';
}

const ACTIVE = new Set<PrinterState>(['preparing', 'printing', 'paused']);
const COMMANDS = { pause: 'print.pause', resume: 'print.resume', stop: 'print.stop' } as const;
const DONE = { pause: 'Paused', resume: 'Resumed', stop: 'Stopped' } as const;
const SERIOUS = new Set(['fatal', 'serious']);
/** Printer and queue ids are UUIDs; anything else (a `|` above all) could blur the signed message. */
const ID = /^[\w-]{1,80}$/;
/** Snapshots the app takes per minute for the phone, whatever the cloud asks. */
const SNAPSHOTS_PER_MINUTE = 150;
/**
 * Refused commands in a minute before the rest are dropped unchecked. Each refusal is noted at most
 * once a minute (an activity line bumps the workspace, which every open tab fetches again).
 */
const REFUSALS_PER_MINUTE = 30;

export class Remote {
	private events = new Map<string, PushEvent>();
	private queueEvent: PushEvent | null = null;
	private replay: ReplayCache;
	private snapshotTimes: number[] = [];
	private refusals = { since: 0, count: 0, unnoted: 0, notedAt: 0 };
	private unsubscribe: (() => void)[] = [];

	constructor(
		private host: CloudHost,
		private lab: Lab,
		private settings: () => RemoteSettings,
		/** Null without a phone key. */
		private keys: () => PhoneKeys | null,
		private plan: () => boolean,
		/** Something the phone should hear about happened: send the printers (and queue) again. */
		private changed: () => void
	) {
		this.replay = new ReplayCache(lab.db);
		const bus = host.bus;
		if (!bus) return;
		const note = (printerId: string, kind: PushKind) => {
			this.events.set(printerId, { kind, at: Date.now() });
			this.changed();
		};
		this.unsubscribe.push(
			bus.on('print.finished', (e) => note(e.printerId, 'finished')),
			bus.on('print.failed', (e) => note(e.printerId, 'failed')),
			bus.on('print.cancelled', (e) => note(e.printerId, 'cancelled')),
			bus.on('print.paused', (e) => note(e.printerId, 'paused')),
			bus.on('hms.raised', (e) => {
				// Only alerts the error database calls serious or fatal wake the phone.
				const info = this.host.module?.('hms')?.describe(e.hms, e.printerId);
				if (info && SERIOUS.has(info.severity)) note(e.printerId, 'alert');
			}),
			bus.on('queue.dispatched', () => this.noteQueue('queue-started')),
			bus.on('queue.held', () => this.noteQueue('queue-held')),
			bus.on('queue.changed', () => this.changed())
		);
	}

	stop() {
		for (const off of this.unsubscribe) off();
		this.unsubscribe = [];
	}

	private noteQueue(kind: PushKind) {
		this.queueEvent = { kind, at: Date.now() };
		this.changed();
	}

	// ---------- What the phone sees ----------

	/**
	 * Every printer, or null while status sharing is off (then the cloud forgets them). `withNext`:
	 * also ask the queue what Start next would send (skipped for the quick change check).
	 */
	summaries(withNext = true): PrinterSummaryV2[] | null {
		const s = this.settings();
		if (!s.shareProgress) return null;
		const camera = this.host.module?.('camera');
		const hms = this.host.module?.('hms');
		const queue = withNext && s.shareQueue ? this.host.module?.('queue') : undefined;
		const plates = queue
			? new Map(queue.list().printers.map((p) => [p.printerId, p.plateClearNeeded]))
			: null;
		return this.host
			.statuses()
			.filter((p) => p.configured && p.id && p.enabled !== false)
			.map((p) => {
				const id = p.id!;
				const state = printerState(p);
				const snap = p.connected ? p.state : null;
				const active = ACTIVE.has(state);
				const summary: PrinterSummaryV2 = {
					id,
					name: (p.name ?? '').slice(0, 80),
					model: (p.modelName ?? p.model ?? '').slice(0, 40),
					state,
					title: snap && state !== 'idle' ? snap.task.slice(0, 120) : '',
					percent: active ? (snap?.percent ?? null) : null,
					remainingMinutes: active ? (snap?.remainingMinutes ?? null) : null,
					layer: active ? (snap?.layer ?? null) : null,
					totalLayers: active ? (snap?.totalLayers ?? null) : null,
					camera: s.snapshots && !!this.keys() && !!camera?.has(id),
					event: this.events.get(id) ?? null
				};
				if (s.shareAlerts)
					summary.hms = hms
						? hms
								.active(id)
								.slice(0, 20)
								.map((a) => ({ key: a.key, severity: a.severity, text: a.text.slice(0, 300) }))
						: (snap?.hms ?? [])
								.slice(0, 20)
								.map((h) => ({ key: hmsKeyOf(h), severity: hmsSeverity(h.code), text: '' }));
				if (queue && plates)
					summary.next = plates.get(id) === false ? queue.startNextItem(id) : null;
				return summary;
			});
	}

	/** The `printers` message: sealed per printer with a phone key, only id, state and event in clear. */
	printersMessage(deviceId: string) {
		const printers = this.summaries();
		const s = this.settings();
		const keys = this.keys();
		return {
			type: 'printers',
			printers:
				printers && keys
					? printers.map((p) => ({
							id: p.id,
							state: p.state,
							event: p.event,
							sealed: seal(keys, Buffer.from(JSON.stringify(p)), `printers|${deviceId}`).toString(
								'base64'
							)
						}))
					: printers,
			control: printers !== null && s.remoteControl && !!keys && this.plan(),
			snapshots: printers !== null && s.snapshots && !!keys
		};
	}

	/** Queued prints, or null while queue sharing is off or there is no queue. */
	queue(): QueueSummary[] | null {
		const queue = this.settings().shareQueue ? this.host.module?.('queue') : undefined;
		if (!queue) return null;
		return queue
			.list()
			.items.filter((i) => i.status !== 'sent')
			.slice(0, 50)
			.map((i) => ({
				id: i.id,
				title: i.title.slice(0, 120),
				printerId: i.printerId,
				status: i.status,
				minutes: i.minutes,
				waitingFor: i.waitingFor?.slice(0, 200) ?? null
			}));
	}

	queueMessage(deviceId: string) {
		const items = this.queue();
		const keys = this.keys();
		return {
			type: 'queue',
			items: items && keys ? undefined : items,
			sealed:
				items && keys
					? seal(keys, Buffer.from(JSON.stringify(items)), `queue|${deviceId}`).toString('base64')
					: undefined,
			event: items ? this.queueEvent : null
		};
	}

	// ---------- Commands from the phone ----------

	/**
	 * Pause, resume, stop (or start the next queued print) from the phone. Applied only when remote
	 * control is on, the Family plan is active, the MAC verifies with the phone key, the command is
	 * recent and was not seen before. Refusals of forged or replayed commands are logged.
	 */
	async control(m: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
		const action = m.action as RemoteAction;
		if (
			typeof m.commandId !== 'string' ||
			!/^[\w-]{8,80}$/.test(m.commandId) ||
			typeof m.printerId !== 'string' ||
			!ID.test(m.printerId) ||
			!REMOTE_ACTIONS.includes(action) ||
			!Number.isSafeInteger(m.at) ||
			(action === 'dispatch' && (typeof m.queueItemId !== 'string' || !ID.test(m.queueItemId)))
		)
			return { ok: false, error: 'Malformed command.' };
		const by = typeof m.by === 'string' && m.by ? m.by.slice(0, 120) : 'Print Lab Cloud';
		const fields = {
			commandId: m.commandId,
			printerId: m.printerId,
			action,
			at: m.at as number,
			queueItemId: action === 'dispatch' ? (m.queueItemId as string) : undefined
		};
		if (!this.settings().remoteControl || !this.settings().shareProgress)
			return { ok: false, error: 'Remote control is off on the computer.' };
		if (!this.plan()) return { ok: false, error: 'Remote control is part of the Family plan.' };
		const keys = this.keys();
		if (!keys) return { ok: false, error: 'Show the phone key on the computer and scan it first.' };
		const refuse = (why: string) => {
			this.noteRefusal(why);
			return { ok: false, error: `Refused: ${why}.` };
		};
		if (this.refusalBudgetSpent())
			return { ok: false, error: 'Refused: too many refused commands. Try again in a minute.' };
		if (!verifyControlMac(keys, fields, m.mac))
			return refuse('it was not signed with this household’s phone key');
		const now = Date.now();
		if (Math.abs(now - fields.at) > CONTROL_WINDOW)
			return refuse('it is too old, or the phone’s clock is off');
		let claim;
		try {
			claim = this.replay.remember(fields.commandId, fields.at, now);
		} catch {
			return { ok: false, error: 'Remote control could not save the command. Try again later.' };
		}
		if (claim === 'replay') return refuse('it was already applied once');
		if (claim === 'full') return refuse('too many recent commands; try again in a few minutes');
		const status = this.host.statuses().find((p) => p.id === fields.printerId);
		if (!status) return { ok: false, error: 'That printer is not here any more.' };
		const name = status.name || 'the printer';
		try {
			if (action === 'dispatch') {
				await this.dispatch(fields.printerId, fields.queueItemId!);
				this.lab.touch('cloud', `Started the next queued print on ${name} from the phone, ${by}`);
			} else {
				if (!this.host.send) throw new AppError(409, 'Printers cannot be controlled here.');
				await this.host.send(fields.printerId, COMMANDS[action]);
				this.lab.touch('cloud', `${DONE[action]} ${name} from the phone, ${by}`);
			}
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof AppError ? error.message : 'The printer did not take it.'
			};
		}
	}

	private refusalBudgetSpent(now = Date.now()) {
		if (now - this.refusals.since >= 60_000)
			this.refusals = { ...this.refusals, since: now, count: 0 };
		return this.refusals.count >= REFUSALS_PER_MINUTE;
	}

	/** One activity line a minute at most, counting the ones in between. */
	private noteRefusal(why: string, now = Date.now()) {
		this.refusals.count++;
		if (now - this.refusals.notedAt < 60_000) {
			this.refusals.unnoted++;
			return;
		}
		const more = this.refusals.unnoted;
		this.refusals.unnoted = 0;
		this.refusals.notedAt = now;
		this.lab.touch(
			'cloud',
			`Refused a command from the phone (${why})` +
				(more ? `; ${more} more refused in the minute before` : '')
		);
	}

	/**
	 * "Start next queued job": only the item the phone was shown as next (the queue's own choice for
	 * Start next on that printer), and only on a plate confirmed clear.
	 */
	private async dispatch(printerId: string, queueItemId: string) {
		const queue = this.host.module?.('queue');
		if (!queue || !this.settings().shareQueue)
			throw new AppError(409, 'The queue is not shared with the phone.');
		const printer = queue.list().printers.find((p) => p.printerId === printerId);
		if (!printer) throw new AppError(404, 'That printer is not here any more.');
		if (printer.plateClearNeeded)
			throw new AppError(409, 'Someone needs to clear the plate and confirm it on the computer.');
		if (queue.startNextItem(printerId) !== queueItemId)
			throw new AppError(409, 'The queue changed. Have another look before starting.');
		// Nothing awaits between the check and the start, so the same item goes.
		queue.printer(printerId, { startNext: true });
	}

	// ---------- Camera pictures ----------

	/** A camera picture sealed for the phone, or why there is none. */
	async snapshot(m: Record<string, unknown>) {
		const requestId = typeof m.requestId === 'string' ? m.requestId.slice(0, 80) : '';
		const printerId = typeof m.printerId === 'string' ? m.printerId.slice(0, 80) : '';
		const answer = (extra: Record<string, unknown>) => ({
			type: 'snapshot',
			requestId,
			printerId,
			...extra
		});
		if (!requestId || !printerId) return answer({ error: 'Malformed request.' });
		const s = this.settings();
		const keys = this.keys();
		if (!s.snapshots || !s.shareProgress) return answer({ error: 'Camera pictures are off.' });
		if (!keys) return answer({ error: 'Show the phone key on the computer and scan it first.' });
		if (!this.plan()) return answer({ error: 'Camera pictures are part of the Family plan.' });
		const now = Date.now();
		this.snapshotTimes = this.snapshotTimes.filter((t) => t > now - 60_000);
		if (this.snapshotTimes.length >= SNAPSHOTS_PER_MINUTE)
			return answer({ error: 'Too many pictures. Wait a moment.' });
		this.snapshotTimes.push(now);
		const camera = this.host.module?.('camera');
		if (!camera?.has(printerId)) return answer({ error: 'That printer has no camera here.' });
		try {
			const jpeg = await fitForPhone(
				await camera.getSnapshot(printerId, {
					maxAgeMs: 1000,
					signal: AbortSignal.timeout(8000)
				}),
				this.host.ffmpeg ? this.host.ffmpeg() : findFfmpeg()
			);
			const capturedAt = Date.now();
			const sealed = sealSnapshot(keys, { requestId, printerId, capturedAt, jpeg });
			return answer({ capturedAt, sealed: sealed.toString('base64') });
		} catch (error) {
			return answer({
				error: error instanceof AppError ? error.message : 'The camera did not send a picture.'
			});
		}
	}
}
