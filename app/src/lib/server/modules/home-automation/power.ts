// Printer power through smart plugs: switch a printer on before a print that finds it off (the
// beforeDispatch hook), and off after a print once it has cooled. The safety rules are pure functions
// so they can be tested on their own: power is never cut while a print runs or while the nozzle is
// hot, and never while the app cannot tell (no report from the printer).
import type { BambuPrinter } from '../../printer/bambu';
import { ACTIVE_PRINTER_STATES, type PrinterSnapshot } from '$lib/shared/printers/status';
import type { PowerState } from '$lib/shared/home-automation';
import { plugClient, PlugError, type PlugClient } from './plugs';
import type { Plug } from './store';

/** How long a recent report still counts as "what the printer is doing" once it went quiet. */
const FRESH_MS = 10 * 60_000;

/** Why power must stay on right now, or null when cutting it is safe. */
export function offBlocker(
	o: {
		connected: boolean;
		snapshot: PrinterSnapshot | null;
		lastSeen: string | null;
		offBelowNozzle: number;
	},
	now = Date.now()
): string | null {
	const s = o.snapshot;
	const fresh = !!o.lastSeen && now - Date.parse(o.lastSeen) < FRESH_MS;
	// Off and silent for a while, or never heard from: nothing tells us it is busy or hot.
	if (!o.connected && !fresh) return null;
	if (!s) return 'The printer has not reported yet.';
	if (ACTIVE_PRINTER_STATES.has(s.gcodeState)) return 'The printer is printing.';
	const hottest = Math.max(s.nozzle ?? -Infinity, ...s.nozzles.map((n) => n.temp ?? -Infinity));
	if (!Number.isFinite(hottest)) return 'The printer has not said how hot the nozzle is.';
	if (hottest >= o.offBelowNozzle)
		return `The nozzle is still ${Math.round(hottest)} °C (off below ${o.offBelowNozzle} °C).`;
	return null;
}

export type OffDecision =
	{ action: 'off' } | { action: 'wait'; reason: string } | { action: 'cancel'; reason: string };

/** How long a lined-up print keeps the power on after the cool-down (PLAN: "due within 15 min"). */
export const QUEUE_GRACE_MS = 15 * 60_000;

/**
 * After a print ended: switch off now, wait, or give up. `queueDue`: the queue has something for this
 * printer. QueueService has no due time, so a lined-up print keeps the power on for 15 minutes after
 * the cool-down; one still waiting then (for a plate check, quiet hours…) is not due soon, and the
 * plug can switch the printer on again for it (`autoOn`). Without auto power-on the queue could not
 * wake it, so the power stays on while anything is lined up. Gives up after `maxWaitMs` so a printer
 * left on by hand is left alone.
 */
export function offDecision(
	o: {
		endedAt: number;
		cooldownMinutes: number;
		connected: boolean;
		snapshot: PrinterSnapshot | null;
		lastSeen: string | null;
		offBelowNozzle: number;
		queueDue: boolean;
		autoOn?: boolean;
		maxWaitMs?: number;
	},
	now = Date.now()
): OffDecision {
	if (o.snapshot && ACTIVE_PRINTER_STATES.has(o.snapshot.gcodeState))
		return { action: 'cancel', reason: 'Another print started.' };
	if (now - o.endedAt > (o.maxWaitMs ?? 6 * 3600_000))
		return { action: 'cancel', reason: 'Waited too long; the plug stays on.' };
	const cooled = o.endedAt + o.cooldownMinutes * 60_000;
	if (o.queueDue && (!o.autoOn || now < cooled + QUEUE_GRACE_MS))
		return { action: 'wait', reason: 'Another print is lined up.' };
	const left = cooled - now;
	if (left > 0)
		return { action: 'wait', reason: `Cooling down (${Math.ceil(left / 60_000)} min).` };
	if (!o.connected) return { action: 'wait', reason: 'Waiting to hear from the printer.' };
	const blocker = offBlocker(o, now);
	if (blocker) return { action: 'wait', reason: blocker };
	return { action: 'off' };
}

export interface PowerTimings {
	/** ensureOn gives up after this long (3 min). */
	onlineTimeoutMs: number;
	/** How often ensureOn looks at the connection. */
	pollMs: number;
	/** How often ensureOn asks the connection to try again instead of waiting for its back-off. */
	retryMs: number;
	/** How often a pending auto power-off is looked at. */
	offCheckMs: number;
}

export const DEFAULT_TIMINGS: PowerTimings = {
	onlineTimeoutMs: 180_000,
	pollMs: 500,
	retryMs: 10_000,
	offCheckMs: 30_000
};

export interface PowerDeps {
	plugFor(printerId: string): Plug | undefined;
	printer(printerId: string): BambuPrinter | undefined;
	queueDue(printerId: string): boolean;
	/** Called on every state change (live channel, events). */
	changed(state: PowerState, what?: { on: boolean; reason: 'auto' | 'manual' | 'print' }): void;
	log(message: string): void;
	client?(plug: Plug): PlugClient;
	timings?: Partial<PowerTimings>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});

/**
 * Makes a printer's connection try again now instead of after its back-off. stop() ends the current
 * socket, whose close handler runs a tick later; start() before that would leave the old handler
 * scheduling a second connection (it sees the printer started again), so wait for the close first.
 */
export async function reconnectNow(printer: BambuPrinter, closeWaitMs = 500): Promise<void> {
	printer.stop();
	await new Promise<void>((resolve) => {
		const timer = setTimeout(done, closeWaitMs);
		function done() {
			clearTimeout(timer);
			printer.off('update', done);
			resolve();
		}
		printer.once('update', done);
	});
	printer.start();
}

export class PowerController {
	private states = new Map<string, PowerState>();
	private pendingOff = new Map<string, { endedAt: number; timer: NodeJS.Timeout }>();
	private t: PowerTimings;

	constructor(private deps: PowerDeps) {
		this.t = { ...DEFAULT_TIMINGS, ...deps.timings };
	}

	private client(plug: Plug) {
		return this.deps.client?.(plug) ?? plugClient(plug.kind, plug.config);
	}

	state(printerId: string): PowerState {
		return this.states.get(printerId) ?? { printerId, on: null, note: '', at: null };
	}

	private update(
		printerId: string,
		change: Partial<PowerState>,
		what?: Parameters<PowerDeps['changed']>[1]
	) {
		const prev = this.state(printerId);
		const next = { ...prev, ...change, printerId };
		if (change.on !== undefined && (change.on !== prev.on || what))
			next.at = new Date().toISOString();
		this.states.set(printerId, next);
		this.deps.changed(next, what);
	}

	/** The note a failed read left, so a later good read clears it but nothing else. */
	private readErrors = new Map<string, string>();

	/** Reads a plug's relay (null for webhooks); errors are kept as the note. */
	async read(printerId: string, signal?: AbortSignal): Promise<boolean | null> {
		const plug = this.deps.plugFor(printerId);
		if (!plug) return null;
		try {
			const on = await this.client(plug).read(signal);
			// "Switching off later…" or "Waiting for the printer…" stay; only a stale read error goes.
			const stale = this.readErrors.get(printerId);
			this.readErrors.delete(printerId);
			const change: Partial<PowerState> = { on };
			if (stale !== undefined && this.state(printerId).note === stale) change.note = '';
			if (on !== this.state(printerId).on || change.note !== undefined)
				this.update(printerId, change);
			return on;
		} catch (error) {
			const note = (error as Error).message;
			this.readErrors.set(printerId, note);
			this.update(printerId, { note });
			throw error;
		}
	}

	/**
	 * The beforeDispatch hook: for a printer with a plug and auto power-on that is not connected,
	 * switches the plug on and waits until the printer reports again (3 min at most).
	 */
	async ensureOn(printerId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
		const plug = this.deps.plugFor(printerId);
		const first = this.deps.printer(printerId);
		if (!plug?.autoOn || !first || first.connected) return;
		this.cancelOff(printerId);
		const since = Date.now();
		await this.switch(printerId, true, 'print', opts.signal);
		this.update(printerId, { note: 'Waiting for the printer to start…' });
		const deadline = since + this.t.onlineTimeoutMs;
		let retried = since;
		const stopped = () => {
			this.update(printerId, { note: '' });
			return new Error('Stopped');
		};
		for (;;) {
			// Looked up each time: a Settings change replaces the printer's connection.
			const printer = this.deps.printer(printerId);
			if (!printer) throw new Error('The printer was removed.');
			if (this.online(printer, since)) break;
			if (opts.signal?.aborted) throw stopped();
			if (Date.now() >= deadline) {
				const ms = this.t.onlineTimeoutMs;
				const limit =
					ms >= 60_000
						? `${Math.round(ms / 60_000)} minute${ms === 60_000 ? '' : 's'}`
						: `${Math.round(ms / 1000)} seconds`;
				const note = `The plug is on but ${printer.name} did not come online within ${limit}.`;
				this.update(printerId, { note });
				throw new Error(note);
			}
			// The connection backs off up to a minute between tries; a printer that just got power
			// should not wait for that.
			if (!printer.connected && Date.now() - retried >= this.t.retryMs) {
				retried = Date.now();
				await reconnectNow(printer);
			}
			await sleep(this.t.pollMs, opts.signal);
		}
		this.update(printerId, { note: '' });
	}

	/** Connected and a report arrived after the plug was switched on. */
	private online(printer: BambuPrinter, since: number) {
		return printer.connected && !!printer.lastSeen && Date.parse(printer.lastSeen) >= since - 1000;
	}

	/** Switches a plug; power off only when it is safe (offBlocker). */
	async switch(
		printerId: string,
		on: boolean,
		reason: 'auto' | 'manual' | 'print',
		signal?: AbortSignal
	): Promise<void> {
		const plug = this.deps.plugFor(printerId);
		if (!plug) throw new PlugError('This printer has no smart plug.');
		if (!on) {
			const printer = this.deps.printer(printerId);
			const blocker = printer
				? offBlocker({
						connected: printer.connected,
						snapshot: printer.snapshot,
						lastSeen: printer.lastSeen,
						offBelowNozzle: plug.offBelowNozzle
					})
				: null;
			if (blocker) throw new PlugError(`Not switching off: ${blocker}`);
			this.cancelOff(printerId);
		}
		this.update(printerId, { note: on ? 'Switching on…' : 'Switching off…' });
		try {
			await this.client(plug).set(on, signal);
		} catch (error) {
			this.update(printerId, { note: (error as Error).message });
			throw error;
		}
		this.update(printerId, { on, note: '' }, { on, reason });
		this.deps.log(`${on ? 'switched on' : 'switched off'} ${printerId} (${reason})`);
	}

	/** A print ended: plan the auto power-off for a plug that has it. */
	printEnded(printerId: string) {
		const plug = this.deps.plugFor(printerId);
		if (!plug?.autoOff) return;
		this.cancelOff(printerId);
		const endedAt = Date.now();
		const timer = setInterval(() => void this.checkOff(printerId), this.t.offCheckMs);
		timer.unref?.();
		this.pendingOff.set(printerId, { endedAt, timer });
		void this.checkOff(printerId);
	}

	cancelOff(printerId: string, note = '') {
		const pending = this.pendingOff.get(printerId);
		if (!pending) return;
		clearInterval(pending.timer);
		this.pendingOff.delete(printerId);
		this.update(printerId, { note });
	}

	/** Pending auto power-offs, by printer (tests, status). */
	pending(): string[] {
		return [...this.pendingOff.keys()];
	}

	private checking = new Set<string>();

	async checkOff(printerId: string) {
		const pending = this.pendingOff.get(printerId);
		const plug = this.deps.plugFor(printerId);
		const printer = this.deps.printer(printerId);
		if (!pending) return;
		if (!plug?.autoOff || !printer) return this.cancelOff(printerId);
		if (this.checking.has(printerId)) return;
		this.checking.add(printerId);
		try {
			const d = offDecision({
				endedAt: pending.endedAt,
				cooldownMinutes: plug.cooldownMinutes,
				connected: printer.connected,
				snapshot: printer.snapshot,
				lastSeen: printer.lastSeen,
				offBelowNozzle: plug.offBelowNozzle,
				queueDue: this.deps.queueDue(printerId),
				autoOn: plug.autoOn
			});
			if (d.action === 'cancel') {
				this.deps.log(`auto power-off for ${printerId} dropped: ${d.reason}`);
				return this.cancelOff(printerId);
			}
			if (d.action === 'wait')
				return this.update(printerId, { note: `Switching off later: ${d.reason}` });
			await this.switch(printerId, false, 'auto');
		} catch (error) {
			this.deps.log(`auto power-off for ${printerId} failed: ${(error as Error).message}`);
		} finally {
			this.checking.delete(printerId);
		}
	}

	stop() {
		for (const id of [...this.pendingOff.keys()]) this.cancelOff(id);
	}
}
