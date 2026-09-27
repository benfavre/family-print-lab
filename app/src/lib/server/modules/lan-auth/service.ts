// Access from other devices: the household password, per-profile PINs, "require login here too",
// logins with throttling, and the session list. Routes and the auth handle go through this service.
import { eq } from 'drizzle-orm';
import type { DB } from '../../db';
import { profilePins, profiles } from '../../db/schema';
import type { SettingsStore } from '../../module-settings';
import { AppError, parse } from '../../validation';
import { PIN_PATTERN, type AuthMode, type AuthStatus } from '$lib/shared/lan-auth';
import { hashSecret, verifySecret } from './password';
import { RateLimiter } from './limiter';
import { SessionStore, type SessionRow } from './sessions';
import { exposedBy } from './decide';
import {
	clearPasswordInput,
	loginInput,
	pinInput,
	setPasswordInput,
	updateInput,
	type AuthSettings
} from './validation';

/** What the auth handle learned about a request (event.locals.auth). */
export interface AuthContext {
	/** From this computer (loopback address and host name). */
	local: boolean;
	session: SessionRow | null;
	ip: string;
	userAgent: string;
}

export interface LoginResult {
	token: string;
	row: SessionRow;
	/** The PIN belonged to a kid profile: this browser goes straight into kid mode. */
	kidProfileId: string | null;
}

const WRONG = 'That password or PIN is not right.';
const ACCOUNT = 'account';

function tooMany(ms: number) {
	const minutes = Math.ceil(ms / 60_000);
	return new AppError(
		429,
		`Too many tries. Wait ${minutes} minute${minutes === 1 ? '' : 's'}, then try again.`
	);
}

export class LanAuth {
	readonly sessions: SessionStore;
	/** Per IP address. */
	readonly ipLimiter: RateLimiter;
	/** For the household as a whole (there are no user names); shorter lockouts, so a stranger
	 * hammering it cannot lock the family out for long. */
	readonly accountLimiter: RateLimiter;

	constructor(
		private db: DB,
		private store: SettingsStore<AuthSettings>,
		private env: Record<string, string | undefined>,
		now: () => number = Date.now,
		/** scrypt N for new hashes; tests lower it (the default is 2^15). */
		private cost?: number
	) {
		this.sessions = new SessionStore(db, now);
		this.ipLimiter = new RateLimiter({ now });
		this.accountLimiter = new RateLimiter({ now, maxLockMs: 15 * 60_000 });
	}

	/** What the auth handle needs on every request. */
	settings(): { hasPassword: boolean; requireLocal: boolean; profilePins: boolean } {
		const s = this.store.get();
		return {
			hasPassword: !!s.passwordHash,
			requireLocal: !!s.passwordHash && s.requireLocal,
			profilePins: !!s.passwordHash && s.profilePins
		};
	}

	mode(): AuthMode {
		const s = this.settings();
		return !s.hasPassword ? 'off' : s.profilePins ? 'profiles' : 'password';
	}

	/** May change the access settings: the household password's sessions, or this computer when it is open. */
	canManage(ctx: AuthContext) {
		return ctx.session ? ctx.session.profileId === null : ctx.local;
	}

	status(ctx: AuthContext): AuthStatus {
		const s = this.settings();
		const manage = this.canManage(ctx);
		return {
			mode: this.mode(),
			requireLocal: s.requireLocal,
			exposedBy: exposedBy(this.env),
			local: ctx.local,
			session: ctx.session ? { id: ctx.session.id, profileId: ctx.session.profileId } : null,
			canManage: manage,
			pins: manage
				? this.db
						.select({ id: profilePins.profileId })
						.from(profilePins)
						.all()
						.map((p) => p.id)
				: [],
			sessions: manage ? this.sessions.list(ctx.session?.id ?? null) : []
		};
	}

	/**
	 * Logs in with the household password or, when profile PINs are on, a profile's PIN. Wrong tries
	 * are throttled per address and for the household; the answer never says which part was wrong.
	 */
	async login(input: unknown, who: { ip: string; userAgent: string }): Promise<LoginResult> {
		const { secret } = parse(loginInput, input);
		const ipKey = `ip:${who.ip}`;
		const wait = Math.max(this.ipLimiter.wait(ipKey), this.accountLimiter.wait(ACCOUNT));
		if (wait > 0) throw tooMany(wait);
		const s = this.store.get();
		if (!s.passwordHash) throw new AppError(409, 'Set a password on the computer first.');
		let profileId: string | null | undefined;
		if (await verifySecret(secret, s.passwordHash)) profileId = null;
		else if (s.profilePins && PIN_PATTERN.test(secret)) profileId = await this.pinOwner(secret);
		if (profileId === undefined) {
			const locked = Math.max(this.ipLimiter.fail(ipKey), this.accountLimiter.fail(ACCOUNT));
			if (locked > 0) throw tooMany(locked);
			throw new AppError(403, WRONG);
		}
		this.ipLimiter.reset(ipKey);
		const { token, row } = this.sessions.create({ profileId, ...who });
		const kid =
			profileId &&
			this.db.select({ kid: profiles.kid }).from(profiles).where(eq(profiles.id, profileId)).get()
				?.kid;
		return { token, row, kidProfileId: kid ? profileId : null };
	}

	/** Sets the household password, or changes it with the current one; other devices log in again. */
	async setPassword(input: unknown, ctx: AuthContext) {
		this.mustManage(ctx);
		const { password, current } = parse(setPasswordInput, input);
		const s = this.store.get();
		if (s.passwordHash) await this.confirm(current, ctx);
		if (await this.pinOwner(password))
			throw new AppError(409, 'A profile already uses that as its PIN. Choose another password.');
		this.store.set({ ...s, passwordHash: await hashSecret(password, this.cost) });
		if (s.passwordHash) this.sessions.endAll(ctx.session?.id);
	}

	/** Back to "only this computer": forgets the password and PINs setting and logs every device out. */
	async clearPassword(input: unknown, ctx: AuthContext) {
		this.mustManage(ctx);
		if (!ctx.local) throw new AppError(403, 'Turn this off on the computer Print Lab runs on.');
		const { current } = parse(clearPasswordInput, input);
		await this.confirm(current, ctx);
		this.store.set({ passwordHash: null, profilePins: false, requireLocal: false });
		this.sessions.endAll();
	}

	/**
	 * Profile PINs on or off, and "require login here too" (which needs the password, and keeps this
	 * browser logged in by giving it a session when it has none).
	 */
	async update(
		input: unknown,
		ctx: AuthContext
	): Promise<{ token: string; row: SessionRow } | null> {
		this.mustManage(ctx);
		const { profilePins: pins, requireLocal, current } = parse(updateInput, input);
		const s = this.store.get();
		if (!s.passwordHash) throw new AppError(409, 'Choose a household password first.');
		if (requireLocal !== undefined && requireLocal !== s.requireLocal)
			await this.confirm(current, ctx);
		this.store.set({
			...s,
			profilePins: pins ?? s.profilePins,
			requireLocal: requireLocal ?? s.requireLocal
		});
		if (pins === false && s.profilePins) this.sessions.endProfiles();
		if (requireLocal && !s.requireLocal && !ctx.session)
			return this.sessions.create({ profileId: null, ip: ctx.ip, userAgent: ctx.userAgent });
		return null;
	}

	/** Gives a profile its own PIN (unique, not the password); its old sessions end. */
	async setPin(profileId: string, input: unknown, ctx: AuthContext) {
		this.mustManage(ctx);
		const { pin } = parse(pinInput, input);
		const profile = this.db.select().from(profiles).where(eq(profiles.id, profileId)).get();
		if (!profile) throw new AppError(404, 'That profile no longer exists.');
		const owner = await this.pinOwner(pin);
		if (owner !== undefined && owner !== profileId)
			throw new AppError(409, 'Another profile already uses that PIN.');
		const hash = this.store.get().passwordHash;
		if (hash && (await verifySecret(pin, hash)))
			throw new AppError(409, 'That is the household password. Choose another PIN.');
		const value = await hashSecret(pin, this.cost);
		this.db
			.insert(profilePins)
			.values({ profileId, hash: value })
			.onConflictDoUpdate({ target: profilePins.profileId, set: { hash: value } })
			.run();
		this.sessions.endProfile(profileId);
	}

	clearPin(profileId: string, ctx: AuthContext) {
		this.mustManage(ctx);
		this.db.delete(profilePins).where(eq(profilePins.profileId, profileId)).run();
		this.sessions.endProfile(profileId);
	}

	/** Logs another device out (the session list). */
	endSession(id: string, ctx: AuthContext) {
		this.mustManage(ctx);
		if (!this.sessions.end(id)) throw new AppError(404, 'That device is already logged out.');
	}

	/** Logs this browser out, or every device. */
	logout(ctx: AuthContext, everywhere = false) {
		if (everywhere) {
			this.mustManage(ctx);
			this.sessions.endAll();
		} else if (ctx.session) this.sessions.end(ctx.session.id);
	}

	/** The profile whose PIN this is (undefined when none). */
	private async pinOwner(secret: string): Promise<string | undefined> {
		if (!PIN_PATTERN.test(secret)) return undefined;
		for (const row of this.db.select().from(profilePins).all())
			if (await verifySecret(secret, row.hash)) return row.profileId;
		return undefined;
	}

	private mustManage(ctx: AuthContext) {
		if (!this.canManage(ctx))
			throw new AppError(403, 'Log in with the household password to change this.');
	}

	/** Checks the current household password (throttled like a login). */
	private async confirm(current: string | undefined, ctx: AuthContext) {
		const hash = this.store.get().passwordHash;
		if (!hash) return;
		const ipKey = `ip:${ctx.ip}`;
		const wait = this.ipLimiter.wait(ipKey);
		if (wait > 0) throw tooMany(wait);
		if (await verifySecret(current ?? '', hash)) return;
		const locked = this.ipLimiter.fail(ipKey);
		if (locked > 0) throw tooMany(locked);
		throw new AppError(403, 'The current password is not right.');
	}
}
