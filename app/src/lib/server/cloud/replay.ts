import { eq } from 'drizzle-orm';
import type { DB } from '../db';
import { meta } from '../db/schema';
import { CONTROL_WINDOW } from './phone';

const KEY = 'cloud.remote.replay';
type Entry = [id: string, expires: number];

/** Local, durable command claims: commit before sending anything to a printer. */
export class ReplayCache {
	constructor(
		private db: DB,
		private max = 5000
	) {}

	remember(id: string, at: number, now: number): 'accepted' | 'replay' | 'full' {
		return this.db.transaction(
			(tx) => {
				const row = tx.select().from(meta).where(eq(meta.key, KEY)).get();
				const saved: unknown = row ? JSON.parse(row.value) : [];
				// A damaged cache must disable control, never silently forget claimed commands.
				if (
					!Array.isArray(saved) ||
					!saved.every(
						(e) =>
							Array.isArray(e) &&
							e.length === 2 &&
							typeof e[0] === 'string' &&
							Number.isSafeInteger(e[1])
					)
				)
					throw new Error('Invalid remote command replay cache.');
				// The signed time may be two minutes ahead. Keep it through the inclusive end of
				// its validity, including across restarts; receipt time alone is not its expiry.
				const entries = (saved as Entry[]).filter(([, expires]) => expires >= now);
				if (entries.some(([seen]) => seen === id)) return 'replay';
				// Never evict an unexpired claim to make room: that would permit a replay.
				if (entries.length >= this.max) return 'full';
				entries.push([id, at + CONTROL_WINDOW]);
				tx.insert(meta)
					.values({ key: KEY, value: JSON.stringify(entries) })
					.onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(entries) } })
					.run();
				return 'accepted';
			},
			// Multiple connections must claim an id atomically, before any async printer work.
			{ behavior: 'immediate' }
		);
	}
}
