// The AI check itself: follows each printer's print (layer events and a 15 s timer), takes a camera
// picture when a check is due, asks the rough check or the chosen AI provider, stores the result,
// raises vision.alert when a problem is sure enough and, only when asked to, pauses the print.
// Nothing leaves the computer unless a parent picked an AI provider in the settings.
import type { EventBus } from '$lib/server/events';
import type { LivePublisher } from '$lib/server/modules';
import type { CameraService } from '$lib/server/modules/contracts';
import type { SettingsStore } from '$lib/server/module-settings';
import type { PrinterManager } from '$lib/server/printer/manager';
import type { Provider, ProviderId } from '$lib/server/ai/providers';
import { AppError } from '$lib/server/validation';
import type { PrinterSnapshot } from '$lib/shared/printers/status';
import {
	VERDICT_LABEL,
	type VisionCheck,
	type VisionSettings,
	type VisionVerdict
} from '$lib/shared/vision';
import { analyse, decodeGrey, judge, type Frame } from './heuristic';
import { buildPrompt, parseVerdict, VISION_SYSTEM, type PrintContext } from './prompt';
import { activeFor, checkDue, decide, newWatch, type PrintWatch } from './schedule';
import { VisionStore } from './store';
import { VERDICT_JSON_SCHEMA } from './validation';

export const LIVE_CHANNEL = 'ai-vision:check';
const TICK_MS = 15_000;
const PROVIDER_TIMEOUT_MS = 180_000;

export interface VisionDeps {
	store: VisionStore;
	settings: SettingsStore<VisionSettings>;
	printers: Pick<PrinterManager, 'get' | 'list'>;
	bus: EventBus;
	live: LivePublisher;
	camera: () => CameraService | undefined;
	provider: (id: ProviderId) => Provider;
	ffmpeg: () => string | null;
	log: (message: string) => void;
	now?: () => number;
}

interface Watched extends PrintWatch {
	jobId: string | null;
	/** The rough check's first-layer picture and last good picture. */
	reference: Frame | null;
	previous: Frame | null;
}

interface Outcome {
	verdict: VisionVerdict;
	confidence: number;
	reason: string;
	error: string | null;
	frame: Buffer | null;
}

export class VisionChecker {
	private watches = new Map<string, Watched>();
	private running = new Map<string, Promise<VisionCheck | null>>();
	private offs: (() => void)[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private now: () => number;

	constructor(private d: VisionDeps) {
		this.now = d.now ?? Date.now;
	}

	start() {
		const bus = this.d.bus;
		this.offs.push(
			bus.on('print.started', (e) => this.follow(e.printerId, e.task, e.jobId, true)),
			bus.on('print.layer', (e) => {
				this.follow(e.printerId, e.task, e.jobId);
				this.maybe(e.printerId, e.layer);
			})
		);
		for (const name of ['print.finished', 'print.failed', 'print.cancelled'] as const)
			this.offs.push(bus.on(name, (e) => this.watches.delete(e.printerId)));
		this.timer = setInterval(() => this.tick(), TICK_MS);
		this.timer.unref?.();
	}

	stop() {
		for (const off of this.offs.splice(0)) off();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	isRunning(printerId: string) {
		return this.running.has(printerId);
	}

	/** Resolves when no check is running (tests). */
	async idle() {
		while (this.running.size) await Promise.allSettled([...this.running.values()]);
	}

	/** Checks every printing printer whose check is due by time (and prints seen for the first time). */
	tick() {
		for (const p of this.d.printers.list()) {
			const s = p.snapshot;
			if (!s || s.gcodeState !== 'RUNNING') continue;
			this.follow(p.id, s.task, null);
			this.maybe(p.id, s.layer);
		}
	}

	/** Runs a check now, whatever the schedule (the "Check now" button). */
	async checkNow(printerId: string, signal?: AbortSignal): Promise<VisionCheck> {
		const p = this.d.printers.get(printerId);
		if (!p) throw new AppError(404, 'That printer is not here any more.');
		if (this.running.has(printerId)) throw new AppError(409, 'A check is already running.');
		const s = p.snapshot;
		if (s?.gcodeState === 'RUNNING' || s?.gcodeState === 'PAUSE')
			this.follow(printerId, s.task, null);
		const check = await this.run(printerId, signal);
		if (!check) throw new AppError(409, 'A check is already running.');
		return check;
	}

	/** Starts following a print (a new name is a new print; `fresh` forgets the old one anyway). */
	private follow(printerId: string, task: string, jobId: string | null, fresh = false) {
		const w = this.watches.get(printerId);
		if (!fresh && w && w.task === task) {
			w.jobId ??= jobId;
			return w;
		}
		const next: Watched = {
			...newWatch(task, this.now()),
			jobId,
			reference: null,
			previous: null
		};
		this.watches.set(printerId, next);
		return next;
	}

	private maybe(printerId: string, layer: number | null) {
		const settings = this.d.settings.get();
		if (!activeFor(settings, printerId) || this.running.has(printerId)) return;
		const p = this.d.printers.get(printerId);
		if (p?.snapshot?.gcodeState !== 'RUNNING') return;
		const w = this.watches.get(printerId);
		if (!w || !checkDue(w, settings, layer, this.now())) return;
		void this.run(printerId).catch((error) =>
			this.d.log(`AI check failed: ${(error as Error).message}`)
		);
	}

	/** One check; null when one is already running for this printer. */
	private run(printerId: string, signal?: AbortSignal): Promise<VisionCheck | null> {
		if (this.running.has(printerId)) return Promise.resolve(null);
		const job = this.check(printerId, signal).finally(() => this.running.delete(printerId));
		this.running.set(printerId, job);
		return job;
	}

	private async check(printerId: string, signal?: AbortSignal): Promise<VisionCheck> {
		const settings = this.d.settings.get();
		const p = this.d.printers.get(printerId);
		if (!p) throw new AppError(404, 'That printer is not here any more.');
		const s = p.snapshot;
		const printing = s?.gcodeState === 'RUNNING' || s?.gcodeState === 'PAUSE';
		const w = printing ? (this.watches.get(printerId) ?? null) : null;
		const now = this.now();
		// Spaced out from the start, so a failing check does not retry every tick.
		if (w) {
			w.lastAt = now;
			w.lastLayer = s?.layer ?? w.lastLayer;
		}
		this.d.live.send(LIVE_CHANNEL, { printerId, running: true });

		const outcome = await this.look(printerId, settings, s, w, signal);
		let check = this.d.store.add({
			printerId,
			jobId: w?.jobId ?? null,
			task: s?.task ?? '',
			layer: printing ? (s?.layer ?? null) : null,
			totalLayers: printing ? (s?.totalLayers ?? null) : null,
			at: new Date(now).toISOString(),
			verdict: outcome.verdict,
			confidence: outcome.confidence,
			reason: outcome.reason,
			provider: settings.method,
			alerted: false,
			paused: false,
			error: outcome.error,
			frame: outcome.frame
		});

		const decision = printing ? decide(outcome, settings, w, now) : { alert: false, pause: false };
		if (decision.alert || decision.pause) {
			let paused = false;
			let reason = outcome.reason;
			if (decision.pause && s?.gcodeState === 'RUNNING') {
				try {
					await p.send('print.pause', {});
					paused = true;
				} catch (error) {
					reason = `${reason} Could not pause the print: ${(error as Error).message}`;
				}
			}
			if (w) w.alertedAt = now;
			check = this.d.store.mark(check.id, { alerted: true, paused, reason });
			const sure = `${Math.round(check.confidence * 100)}% sure${settings.method === 'local' ? ', rough check' : ''}`;
			this.d.bus.emit('vision.alert', {
				printerId,
				printerName: p.name,
				jobId: check.jobId,
				task: check.task,
				checkId: check.id,
				verdict: check.verdict,
				confidence: check.confidence,
				layer: check.layer,
				paused,
				provider: check.provider,
				detail: check.reason,
				reason: `${VERDICT_LABEL[check.verdict]} (${sure}). ${check.reason}${paused ? ' The print is paused.' : ''}`
			});
		}
		this.d.live.send(LIVE_CHANNEL, { printerId, running: false, check });
		return check;
	}

	/** Takes the picture and asks the rough check or the provider; failures become an 'unsure' outcome. */
	private async look(
		printerId: string,
		settings: VisionSettings,
		s: PrinterSnapshot | null,
		w: Watched | null,
		signal?: AbortSignal
	): Promise<Outcome> {
		const failed = (error: string, frame: Buffer | null = null): Outcome => ({
			verdict: 'unsure',
			confidence: 0,
			reason: '',
			error,
			frame
		});
		const camera = this.d.camera();
		if (!camera) return failed('Camera support is not running, so there is no picture to check.');
		if (!camera.has(printerId))
			return failed(
				'The camera cannot be reached. Check that the printer is online and LAN liveview is on.'
			);
		let jpeg: Buffer;
		try {
			// Fresh pictures only: an older one could show the bed before the print began.
			jpeg = await camera.getSnapshot(printerId, { maxAgeMs: 1500, signal });
		} catch (error) {
			return failed(`No picture from the camera: ${(error as Error).message}`);
		}

		if (settings.method === 'local') {
			const ffmpeg = this.d.ffmpeg();
			if (!ffmpeg) return failed('The rough check needs ffmpeg on this computer.', jpeg);
			let frame: Frame;
			try {
				frame = analyse(await decodeGrey(ffmpeg, jpeg));
			} catch (error) {
				return failed((error as Error).message, jpeg);
			}
			if (!w)
				return {
					verdict: 'unsure',
					confidence: 0,
					reason:
						'Nothing is printing, so there is nothing to compare with. The rough check works during a print.',
					error: null,
					frame: jpeg
				};
			if (!w.reference) {
				w.reference = frame;
				w.hasReference = true;
				return {
					verdict: 'ok',
					confidence: 0.6,
					reason: 'The first picture of this print. Later checks compare with it.',
					error: null,
					frame: jpeg
				};
			}
			const r = judge(w.reference, w.previous, frame);
			if (r.verdict === 'ok') w.previous = frame;
			return {
				verdict: r.verdict,
				confidence: r.confidence,
				reason: r.reason,
				error: null,
				frame: jpeg
			};
		}

		const p = this.d.printers.get(printerId);
		const context: PrintContext = {
			printerModel: p?.model.name ?? 'Bambu Lab printer',
			task: s?.task ?? '',
			layer: w ? (s?.layer ?? null) : null,
			totalLayers: w ? (s?.totalLayers ?? null) : null,
			percent: w ? (s?.percent ?? null) : null,
			material: s ? materialOf(s) : null,
			elapsedMinutes: w ? (this.now() - w.startedAt) / 60_000 : null
		};
		const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
		try {
			const raw = await this.d.provider(settings.method).structured({
				system: VISION_SYSTEM,
				prompt: buildPrompt(context),
				schema: VERDICT_JSON_SCHEMA,
				image: { mediaType: 'image/jpeg', data: jpeg.toString('base64') },
				effort: 'low',
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout
			});
			const v = parseVerdict(raw);
			if (w && v.verdict !== 'unsure') w.hasReference = true;
			return { ...v, error: null, frame: jpeg };
		} catch (error) {
			return failed((error as Error).message, jpeg);
		}
	}
}

/** The filament type in the active tray, if the printer says. */
export function materialOf(s: PrinterSnapshot): string | null {
	if (s.activeTray === null) return null;
	const trays = [...s.ams.flatMap((u) => u.trays), ...s.externalSpools];
	return trays.find((t) => t.global === s.activeTray)?.type || null;
}
