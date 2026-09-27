// Login throttling: after `max` wrong tries within `windowMs`, a key (an IP address, or the household
// account) is locked out, for `lockMs` the first time and twice as long each time after that, up to
// `maxLockMs`. Kept in memory: a restart forgets it, which is fine for a home server.

export interface LimiterOptions {
	max?: number;
	windowMs?: number;
	lockMs?: number;
	maxLockMs?: number;
	/** Lockouts stop doubling after this long without one. */
	forgetMs?: number;
	now?: () => number;
}

interface Entry {
	failures: number[];
	strikes: number;
	lockedUntil: number;
	lastStrike: number;
}

const MINUTE = 60_000;

export class RateLimiter {
	private entries = new Map<string, Entry>();
	private o: Required<LimiterOptions>;

	constructor(o: LimiterOptions = {}) {
		this.o = {
			max: 5,
			windowMs: 5 * MINUTE,
			lockMs: 5 * MINUTE,
			maxLockMs: 60 * MINUTE,
			forgetMs: 24 * 60 * MINUTE,
			now: Date.now,
			...o
		};
	}

	/** How long `key` must wait before trying again (0: it may try now). */
	wait(key: string): number {
		const entry = this.entries.get(key);
		return entry ? Math.max(0, entry.lockedUntil - this.o.now()) : 0;
	}

	/** Records a wrong try; returns how long `key` is now locked out (0 if not). */
	fail(key: string): number {
		const now = this.o.now();
		const entry = this.entries.get(key) ?? {
			failures: [],
			strikes: 0,
			lockedUntil: 0,
			lastStrike: 0
		};
		if (entry.strikes && now - entry.lastStrike > this.o.forgetMs) entry.strikes = 0;
		entry.failures = entry.failures.filter((t) => now - t < this.o.windowMs);
		entry.failures.push(now);
		if (entry.failures.length >= this.o.max) {
			entry.strikes++;
			entry.lastStrike = now;
			entry.failures = [];
			entry.lockedUntil =
				now + Math.min(this.o.lockMs * 2 ** (entry.strikes - 1), this.o.maxLockMs);
		}
		this.entries.set(key, entry);
		this.prune(now);
		return Math.max(0, entry.lockedUntil - now);
	}

	/** Forgets a key's wrong tries (after a successful login). */
	reset(key: string) {
		this.entries.delete(key);
	}

	/** Keeps memory bounded when many addresses try: drops entries with nothing left to remember. */
	private prune(now: number) {
		if (this.entries.size < 1000) return;
		for (const [key, e] of this.entries)
			if (
				e.lockedUntil <= now &&
				e.failures.every((t) => now - t >= this.o.windowMs) &&
				(!e.strikes || now - e.lastStrike > this.o.forgetMs)
			)
				this.entries.delete(key);
	}
}
