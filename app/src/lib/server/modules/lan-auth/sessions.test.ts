import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../../db';
import { sessions } from '../../db/schema';
import { Lab } from '../../lab';
import { SessionStore, tokenHash } from './sessions';

const DAY = 24 * 60 * 60 * 1000;
let db: DB, store: SessionStore, clock: { now: number }, lab: Lab;
beforeEach(() => {
	db = openDatabase(':memory:');
	lab = new Lab(db);
	clock = { now: Date.parse('2026-09-01T10:00:00Z') };
	store = new SessionStore(db, () => clock.now);
});
const who = { userAgent: 'Firefox', ip: '192.168.1.20' };

describe('SessionStore', () => {
	it('keeps only the hash of the cookie, and finds the session by the cookie', () => {
		const { token, row } = store.create({ profileId: null, ...who });
		expect(token).toMatch(/^[\w-]{43}$/);
		expect(row.id).toBe(tokenHash(token));
		expect(
			db
				.select()
				.from(sessions)
				.all()
				.map((s) => s.id)
		).toEqual([tokenHash(token)]);
		expect(store.find(token)?.row.id).toBe(row.id);
		expect(store.find(row.id)).toBeNull(); // the stored hash is not a cookie
		expect(store.find(undefined)).toBeNull();
		expect(store.find('x'.repeat(500))).toBeNull();
	});

	it('lasts 30 days from the last visit (sliding), then is gone', () => {
		const { token } = store.create({ profileId: null, ...who });
		clock.now += 5 * 60_000;
		expect(store.find(token)?.touched).toBe(false); // too soon to write again
		clock.now += 20 * DAY;
		const seen = store.find(token, { ip: '192.168.1.30' });
		expect(seen?.touched).toBe(true);
		expect(seen?.row.ip).toBe('192.168.1.30');
		expect(seen?.row.expiresAt).toBe(new Date(clock.now + 30 * DAY).toISOString());
		clock.now += 29 * DAY;
		expect(store.find(token)).not.toBeNull();
		clock.now += 31 * DAY;
		expect(store.find(token)).toBeNull();
		expect(db.select().from(sessions).all()).toEqual([]);
	});

	it('logs out one, everyone but one, one profile, or every PIN session, and says which', () => {
		const kid = lab.createProfile({ name: 'Ada', color: 'orange' });
		const a = store.create({ profileId: null, ...who });
		const b = store.create({ profileId: null, ...who });
		const c = store.create({ profileId: kid, ...who });
		const ended: string[][] = [];
		store.events.on('ended', (ids) => ended.push(ids));
		store.endProfile(kid);
		expect(store.find(c.token)).toBeNull();
		store.endAll(a.row.id);
		expect(store.find(a.token)).not.toBeNull();
		expect(store.find(b.token)).toBeNull();
		expect(store.end(a.row.id)).toBe(true);
		expect(store.end(a.row.id)).toBe(false);
		expect(ended).toEqual([[c.row.id], [b.row.id], [a.row.id]]);
		const d = store.create({ profileId: kid, ...who });
		const e = store.create({ profileId: null, ...who });
		store.endProfiles();
		expect(store.find(d.token)).toBeNull();
		expect(store.find(e.token)).not.toBeNull();
	});

	it('lists live sessions, newest visit first, marking this one', () => {
		const a = store.create({ profileId: null, ...who });
		clock.now += 60_000;
		const b = store.create({ profileId: null, userAgent: 'Safari', ip: '192.168.1.21' });
		expect(store.list(b.row.id).map((s) => [s.userAgent, s.current])).toEqual([
			['Safari', true],
			['Firefox', false]
		]);
		clock.now += 31 * DAY;
		store.prune();
		expect(store.list(a.row.id)).toEqual([]);
	});

	it('goes when its profile is deleted, and a released kid session becomes a household one', () => {
		const id = lab.createProfile({ name: 'Ada', color: 'orange' });
		const s = store.create({ profileId: id, ...who });
		store.release(s.row.id);
		expect(store.find(s.token)?.row.profileId).toBeNull();
		const t = store.create({ profileId: id, ...who });
		lab.deleteProfile(id);
		expect(store.find(t.token)).toBeNull();
	});
});
