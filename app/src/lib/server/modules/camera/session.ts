// One printer's camera stream, shared by everyone watching: the source runs while someone watches or
// waits for a snapshot, and stops LINGER_MS after the last one leaves (so a page reload or the card
// snapshots every 10 s do not restart the printer's stream each time).
import type { CameraSource } from './source';

export const LINGER_MS = 30_000;

export interface SessionState {
	live: boolean;
	error: string | null;
	lastFrameAt: string | null;
}

export class CameraSession {
	latest: { jpeg: Buffer; at: number } | null = null;
	live = false;
	error: string | null = null;
	private viewers = new Map<(jpeg: Buffer) => void, (() => void) | undefined>();
	private waiters = 0;
	private running = false;
	private linger?: NodeJS.Timeout;

	constructor(
		private source: CameraSource,
		/** Identifies the connection details; a new key means a new source. */
		public key: string,
		private o: { lingerMs?: number; onState?: (s: SessionState) => void } = {}
	) {}

	state(): SessionState {
		return {
			live: this.live,
			error: this.error,
			lastFrameAt: this.latest ? new Date(this.latest.at).toISOString() : null
		};
	}

	private changed() {
		this.o.onState?.(this.state());
	}

	private ensureRunning() {
		clearTimeout(this.linger);
		this.linger = undefined;
		if (this.running) return;
		this.running = true;
		this.source.start({
			frame: (jpeg) => {
				this.latest = { jpeg, at: Date.now() };
				const news = !this.live || this.error !== null;
				this.live = true;
				this.error = null;
				if (news) this.changed();
				for (const fn of [...this.viewers.keys()]) fn(jpeg);
			},
			error: (message) => {
				const news = this.live || this.error !== message;
				this.live = false;
				this.error = message;
				if (news) this.changed();
			}
		});
	}

	private release() {
		if (this.viewers.size || this.waiters || !this.running) return;
		clearTimeout(this.linger);
		this.linger = setTimeout(() => this.halt(), this.o.lingerMs ?? LINGER_MS);
		this.linger.unref?.();
	}

	private halt() {
		clearTimeout(this.linger);
		this.linger = undefined;
		if (!this.running) return;
		this.running = false;
		this.source.stop();
		const news = this.live;
		this.live = false;
		if (news) this.changed();
	}

	get watching() {
		return this.viewers.size;
	}

	get active() {
		return this.running;
	}

	/**
	 * Every new frame goes to fn (the newest one first, when fresh) until the returned unsubscribe is
	 * called; onEnd runs if the session stops first (printer removed or gone offline).
	 */
	subscribe(fn: (jpeg: Buffer) => void, onEnd?: () => void): () => void {
		this.viewers.set(fn, onEnd);
		this.ensureRunning();
		if (this.latest && Date.now() - this.latest.at < 5000) fn(this.latest.jpeg);
		return () => {
			if (this.viewers.delete(fn)) this.release();
		};
	}

	/** The newest frame no older than maxAgeMs, waiting for the next one when needed. */
	async snapshot(o: {
		maxAgeMs: number;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<Buffer> {
		if (this.latest && Date.now() - this.latest.at <= o.maxAgeMs) {
			// Keep the stream warm for the next ask.
			if (this.running) {
				this.ensureRunning();
				this.release();
			}
			return this.latest.jpeg;
		}
		this.waiters++;
		this.ensureRunning();
		try {
			return await new Promise<Buffer>((resolve, reject) => {
				const done = (fn: () => void) => {
					clearTimeout(timer);
					this.viewers.delete(onFrame);
					o.signal?.removeEventListener('abort', onAbort);
					fn();
				};
				const onFrame = (jpeg: Buffer) => done(() => resolve(jpeg));
				const onAbort = () => done(() => reject(new Error('Stopped')));
				const timer = setTimeout(
					() =>
						done(() =>
							reject(new Error(this.error ?? 'The camera sent no picture in time. Try again.'))
						),
					o.timeoutMs ?? 15_000
				);
				this.viewers.set(onFrame, () =>
					done(() => reject(new Error(this.error ?? 'The camera stopped.')))
				);
				o.signal?.addEventListener('abort', onAbort, { once: true });
			});
		} finally {
			this.waiters--;
			this.release();
		}
	}

	/** New connection details: keep the viewers, swap the source. */
	replace(source: CameraSource, key: string) {
		const wasRunning = this.running;
		this.halt();
		this.source = source;
		this.key = key;
		this.latest = null;
		this.error = null;
		if (wasRunning && (this.viewers.size || this.waiters)) this.ensureRunning();
	}

	stop() {
		this.halt();
		const ends = [...this.viewers.values()];
		this.viewers.clear();
		for (const end of ends) end?.();
	}
}
