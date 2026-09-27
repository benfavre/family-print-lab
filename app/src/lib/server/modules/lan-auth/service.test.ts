import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../../db';
import { Lab } from '../../lab';
import { ParentPin } from '../../kid/pin';
import { moduleSettings } from '../../module-settings';
import { AppError } from '../../validation';
import { LanAuth, type AuthContext } from './service';
import { authSettingsSchema, AUTH_DEFAULTS } from './validation';

let db: DB, lab: Lab, auth: LanAuth, clock: { now: number };
const here: AuthContext = { local: true, session: null, ip: '127.0.0.1', userAgent: 'Firefox' };
const lan = { ip: '192.168.1.20', userAgent: 'Safari' };
const settings = () => moduleSettings(db, 'lan-auth', authSettingsSchema, AUTH_DEFAULTS);

beforeEach(() => {
	db = openDatabase(':memory:');
	lab = new Lab(db);
	clock = { now: Date.parse('2026-09-01T10:00:00Z') };
	auth = new LanAuth(db, settings(), { ALLOWED_HOSTS: 'printlab.local' }, () => clock.now, 2 ** 10);
});

async function fails(p: Promise<unknown>): Promise<AppError> {
	try {
		await p;
	} catch (error) {
		if (error instanceof AppError) return error;
		throw error;
	}
	throw new Error('Expected an AppError');
}

/** A household-password session on another device, as the handle would see it. */
async function lanHousehold(): Promise<AuthContext> {
	const { row } = await auth.login({ secret: 'correct horse' }, lan);
	return { local: false, session: row, ...lan };
}

describe('the household password', () => {
	it('is off by default: only this computer, nothing stored', () => {
		expect(auth.mode()).toBe('off');
		expect(auth.status(here)).toMatchObject({
			mode: 'off',
			requireLocal: false,
			exposedBy: 'ALLOWED_HOSTS=printlab.local',
			canManage: true,
			sessions: []
		});
	});

	it('is set from this computer, never shown again, and lets other devices log in', async () => {
		await auth.setPassword({ password: 'correct horse' }, here);
		expect(auth.mode()).toBe('password');
		expect(JSON.stringify(auth.status(here))).not.toMatch(/scrypt|correct/);
		expect(settings().get().passwordHash).toMatch(/^scrypt\$/);
		const ok = await auth.login({ secret: 'correct horse' }, lan);
		expect(ok.row.profileId).toBeNull();
		expect(ok.kidProfileId).toBeNull();
		expect(auth.status(here).sessions).toHaveLength(1);
	});

	it('needs at least 8 characters, and the current one to change it', async () => {
		expect((await fails(auth.setPassword({ password: 'short' }, here))).status).toBe(400);
		await auth.setPassword({ password: 'correct horse' }, here);
		const other = await lanHousehold();
		expect((await fails(auth.setPassword({ password: 'battery staple' }, here))).status).toBe(403);
		await auth.setPassword({ password: 'battery staple', current: 'correct horse' }, here);
		// Every other device logs in again.
		expect(auth.sessions.list(null).map((s) => s.id)).not.toContain(other.session!.id);
		expect((await fails(auth.login({ secret: 'correct horse' }, lan))).status).toBe(403);
		await auth.login({ secret: 'battery staple' }, lan);
	});

	it('can only be managed by the household password or this computer while it is open', async () => {
		await auth.setPassword({ password: 'correct horse' }, here);
		const nobody: AuthContext = { local: false, session: null, ...lan };
		expect(auth.canManage(nobody)).toBe(false);
		expect(auth.status(nobody)).toMatchObject({ canManage: false, sessions: [], pins: [] });
		expect((await fails(auth.update({ profilePins: true }, nobody))).status).toBe(403);
		expect(auth.canManage(await lanHousehold())).toBe(true);
	});

	it('is turned off only on this computer, with the password; every device is logged out', async () => {
		await auth.setPassword({ password: 'correct horse' }, here);
		const other = await lanHousehold();
		expect((await fails(auth.clearPassword({ current: 'correct horse' }, other))).status).toBe(403);
		expect((await fails(auth.clearPassword({ current: 'nope' }, here))).status).toBe(403);
		await auth.clearPassword({ current: 'correct horse' }, here);
		expect(auth.mode()).toBe('off');
		expect(auth.sessions.list(null)).toEqual([]);
		expect((await fails(auth.login({ secret: 'correct horse' }, lan))).status).toBe(409);
	});
});

describe('logging in', () => {
	beforeEach(async () => {
		await auth.setPassword({ password: 'correct horse' }, here);
	});

	it('gives the same answer whatever was wrong (no user names to guess)', async () => {
		const wrong = await fails(auth.login({ secret: 'wrong' }, lan));
		const pinLike = await fails(auth.login({ secret: '1234' }, lan));
		expect([wrong.status, wrong.message]).toEqual([403, 'That password or PIN is not right.']);
		expect([pinLike.status, pinLike.message]).toEqual([wrong.status, wrong.message]);
	});

	it('locks an address out after 5 wrong tries in 5 minutes, then twice as long', async () => {
		for (let i = 0; i < 4; i++) await fails(auth.login({ secret: 'wrong' }, lan));
		expect((await fails(auth.login({ secret: 'wrong' }, lan))).status).toBe(429);
		// Even the right password waits: a locked-out guesser learns nothing.
		const locked = await fails(auth.login({ secret: 'correct horse' }, lan));
		expect(locked.status).toBe(429);
		expect(locked.message).toMatch(/Wait 5 minutes/);
		clock.now += 5 * 60_000;
		for (let i = 0; i < 4; i++) await fails(auth.login({ secret: 'wrong' }, lan));
		expect((await fails(auth.login({ secret: 'wrong' }, lan))).message).toMatch(/Wait 10 minutes/);
	});

	it('also throttles the household account across addresses, more gently', async () => {
		for (let i = 0; i < 5; i++)
			await fails(auth.login({ secret: 'wrong' }, { ip: `192.168.1.${i + 50}`, userAgent: '' }));
		const other = await fails(
			auth.login({ secret: 'correct horse' }, { ip: '192.168.1.99', userAgent: '' })
		);
		expect(other.status).toBe(429);
		clock.now += 5 * 60_000;
		await auth.login({ secret: 'correct horse' }, { ip: '192.168.1.99', userAgent: '' });
	});

	it('forgets an address’s wrong tries after it gets in', async () => {
		for (let i = 0; i < 4; i++) await fails(auth.login({ secret: 'wrong' }, lan));
		await auth.login({ secret: 'correct horse' }, lan);
		for (let i = 0; i < 4; i++) await fails(auth.login({ secret: 'wrong' }, lan));
		expect((await fails(auth.login({ secret: 'wrong' }, lan))).status).toBe(429);
	});
});

describe('parallel guesses', () => {
	it('are counted one by one, so a burst cannot slip past the limiter', async () => {
		await auth.setPassword({ password: 'correct horse' }, here);
		const tries = await Promise.allSettled(
			Array.from({ length: 12 }, (_, i) => auth.login({ secret: `guess ${i}` }, lan))
		);
		const statuses = tries.map((r) =>
			r.status === 'rejected' ? (r.reason as AppError).status : 200
		);
		expect(statuses).toEqual([403, 403, 403, 403, 429, 429, 429, 429, 429, 429, 429, 429]);
	});

	it('keep going after a check fails', async () => {
		await auth.setPassword({ password: 'correct horse' }, here);
		const [bad, good] = await Promise.allSettled([
			auth.login({ secret: 'nope' }, lan),
			auth.login({ secret: 'correct horse' }, lan)
		]);
		expect(bad.status).toBe('rejected');
		expect(good.status).toBe('fulfilled');
	});
});

describe('profile PINs', () => {
	let mum: string, kid: string;
	beforeEach(async () => {
		await auth.setPassword({ password: 'correct horse' }, here);
		new ParentPin(db).set({ pin: '9999' });
		mum = lab.createProfile({ name: 'Mum', color: 'blue' });
		kid = lab.createProfile({ name: 'Ada', color: 'orange', age: 8, kid: 'junior' });
		await auth.setPin(mum, { pin: '1234' }, here);
		await auth.setPin(kid, { pin: '5678' }, here);
	});

	it('work only while profile PINs are on', async () => {
		expect((await fails(auth.login({ secret: '1234' }, lan))).status).toBe(403);
		await auth.update({ profilePins: true }, here);
		expect(auth.mode()).toBe('profiles');
		const r = await auth.login({ secret: '1234' }, lan);
		expect([r.row.profileId, r.kidProfileId]).toEqual([mum, null]);
		expect(auth.status(here).pins.sort()).toEqual([mum, kid].sort());
	});

	it('log a kid straight into kid mode, and a PIN session cannot manage access', async () => {
		await auth.update({ profilePins: true }, here);
		const r = await auth.login({ secret: '5678' }, lan);
		expect([r.row.profileId, r.kidProfileId]).toEqual([kid, kid]);
		const mine = await auth.login({ secret: '1234' }, lan);
		expect(auth.canManage({ local: false, session: mine.row, ...lan })).toBe(false);
	});

	it('for a kid need a parent PIN, so only a grown-up can leave the kid mode it opens', async () => {
		// Kid profiles already need one to exist; a restored backup can still lack it.
		db.$client.prepare("delete from meta where key = 'parent_pin'").run();
		expect((await fails(auth.setPin(kid, { pin: '2468' }, here))).message).toMatch(
			/parent PIN first/
		);
		await auth.setPin(mum, { pin: '2468' }, here);
	});

	it('are unique, never the password, 4 to 8 digits', async () => {
		expect((await fails(auth.setPin(kid, { pin: '1234' }, here))).status).toBe(409);
		expect((await fails(auth.setPin(kid, { pin: '12a4' }, here))).status).toBe(400);
		await auth.setPassword({ password: '24681357', current: 'correct horse' }, here);
		expect((await fails(auth.setPin(kid, { pin: '24681357' }, here))).message).toMatch(
			/household password/
		);
		await auth.setPin(mum, { pin: '12345678' }, here);
		expect(
			(await fails(auth.setPassword({ password: '12345678', current: '24681357' }, here))).message
		).toMatch(/already uses that as its PIN/);
	});

	it('changing, removing or switching them off logs those profiles out', async () => {
		await auth.update({ profilePins: true }, here);
		const a = await auth.login({ secret: '1234' }, lan);
		await auth.setPin(mum, { pin: '4321' }, here);
		expect(auth.sessions.find(a.token)).toBeNull();
		const b = await auth.login({ secret: '5678' }, lan);
		auth.clearPin(kid, here);
		expect(auth.sessions.find(b.token)).toBeNull();
		const c = await auth.login({ secret: '4321' }, lan);
		const household = await auth.login({ secret: 'correct horse' }, lan);
		await auth.update({ profilePins: false }, here);
		expect(auth.sessions.find(c.token)).toBeNull();
		expect(auth.sessions.find(household.token)).not.toBeNull();
	});
});

describe('require login here too', () => {
	beforeEach(async () => {
		await auth.setPassword({ password: 'correct horse' }, here);
	});

	it('needs the current password, and keeps this browser logged in', async () => {
		expect((await fails(auth.update({ requireLocal: true }, here))).status).toBe(403);
		const started = await auth.update({ requireLocal: true, current: 'correct horse' }, here);
		expect(started?.row.profileId).toBeNull();
		expect(auth.settings().requireLocal).toBe(true);
		const withSession = { ...here, session: started!.row };
		expect(
			await auth.update({ requireLocal: false, current: 'correct horse' }, withSession)
		).toBeNull();
	});

	it('needs a password first', async () => {
		await auth.clearPassword({ current: 'correct horse' }, here);
		expect((await fails(auth.update({ requireLocal: true }, here))).status).toBe(409);
	});
});
