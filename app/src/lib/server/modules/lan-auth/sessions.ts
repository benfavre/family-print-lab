// Login sessions. The browser holds a random token in an HttpOnly cookie; the database keeps only its
// SHA-256, so a copy of the database (or a backup) cannot be used to log in. Sessions last 30 days
// from the last visit (sliding), and can be ended one by one or all at once.
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { desc, eq, isNotNull, lt, ne, type SQL } from 'drizzle-orm';
import type { DB } from '../../db';
import { sessions } from '../../db/schema';
import type { AuthSessionInfo } from '$lib/shared/lan-auth';

export const SESSION_COOKIE = 'print_lab_session';
export const SESSION_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
/** A visit moves the expiry forward at most this often (fewer writes). */
const TOUCH_EVERY = 10 * 60 * 1000;

export type SessionRow = typeof sessions.$inferSelect;

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class SessionStore {
	/** Emits 'ended' with the ids of sessions that were logged out (open live streams close). */
	readonly events = new EventEmitter();

	constructor(
		private db: DB,
		private now = () => Date.now()
	) {}

	/** Starts a session; returns the cookie value (shown once, never stored). */
	create(o: { profileId: string | null; userAgent: string; ip: string }): {
		token: string;
		row: SessionRow;
	} {
		const token = randomBytes(32).toString('base64url');
		const at = new Date(this.now());
		const row = this.db
			.insert(sessions)
			.values({
				id: tokenHash(token),
				profileId: o.profileId,
				createdAt: at.toISOString(),
				lastSeenAt: at.toISOString(),
				expiresAt: new Date(at.getTime() + SESSION_DAYS * DAY).toISOString(),
				userAgent: o.userAgent.slice(0, 300),
				ip: o.ip.slice(0, 64)
			})
			.returning()
			.get();
		return { token, row };
	}

	/**
	 * The live session for a cookie value, or null. A visit slides its expiry forward; `touched` is
	 * true when it did, so the caller can renew the cookie too.
	 */
	find(
		token: string | undefined,
		seen?: { ip: string }
	): { row: SessionRow; touched: boolean } | null {
		if (!token || token.length > 100) return null;
		const id = tokenHash(token);
		const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
		if (!row) return null;
		const now = this.now();
		if (Date.parse(row.expiresAt) <= now) {
			this.db.delete(sessions).where(eq(sessions.id, id)).run();
			return null;
		}
		if (now - Date.parse(row.lastSeenAt) < TOUCH_EVERY) return { row, touched: false };
		const next = {
			lastSeenAt: new Date(now).toISOString(),
			expiresAt: new Date(now + SESSION_DAYS * DAY).toISOString(),
			...(seen ? { ip: seen.ip.slice(0, 64) } : {})
		};
		this.db.update(sessions).set(next).where(eq(sessions.id, id)).run();
		return { row: { ...row, ...next }, touched: true };
	}

	list(currentId: string | null): AuthSessionInfo[] {
		return this.db
			.select()
			.from(sessions)
			.orderBy(desc(sessions.lastSeenAt))
			.all()
			.filter((s) => Date.parse(s.expiresAt) > this.now())
			.map((s) => ({ ...s, current: s.id === currentId }));
	}

	/** Ends one session; false when there was none with that id. */
	end(id: string): boolean {
		const done = this.db.delete(sessions).where(eq(sessions.id, id)).run().changes > 0;
		if (done) this.events.emit('ended', [id]);
		return done;
	}

	/** Ends every session, except `keep` when given. */
	endAll(keep?: string | null) {
		this.endWhere(keep ? ne(sessions.id, keep) : undefined);
	}

	/** Ends every session a profile started with its PIN (PIN changed or removed). */
	endProfile(profileId: string) {
		this.endWhere(eq(sessions.profileId, profileId));
	}

	/** Ends every session started with a profile PIN (profile PINs switched off). */
	endProfiles() {
		this.endWhere(isNotNull(sessions.profileId));
	}

	/** A grown-up unlocked this device with the parent PIN: the session no longer belongs to a kid. */
	release(id: string) {
		this.db.update(sessions).set({ profileId: null }).where(eq(sessions.id, id)).run();
	}

	/** Deletes expired sessions. */
	prune() {
		this.db
			.delete(sessions)
			.where(lt(sessions.expiresAt, new Date(this.now()).toISOString()))
			.run();
	}

	private endWhere(where: SQL | undefined) {
		const ids = this.db
			.select({ id: sessions.id })
			.from(sessions)
			.where(where)
			.all()
			.map((s) => s.id);
		if (!ids.length) return;
		this.db.delete(sessions).where(where).run();
		this.events.emit('ended', ids);
	}
}
