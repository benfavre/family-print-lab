// The parent PIN: needed to leave kid mode. Stored as a salted scrypt hash in the meta table.
// It keeps curious kids in their space; it is not a login (see SECURITY.md).
import { eq } from 'drizzle-orm';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../db';
import { meta } from '../db/schema';
import { AppError, parse } from '../validation';

const KEY = 'parent_pin';
export const pinSchema = z.string().regex(/^\d{4,8}$/, 'Use 4 to 8 digits.');

function hash(pin: string, salt = randomBytes(16)) {
	return `scrypt$${salt.toString('base64')}$${scryptSync(pin, salt, 32).toString('base64')}`;
}

export class ParentPin {
	private failures = 0;
	private lockedUntil = 0;

	constructor(
		private db: DB,
		private now = () => Date.now()
	) {}

	isSet() {
		return !!this.db.select().from(meta).where(eq(meta.key, KEY)).get();
	}

	/** Checks a PIN. Wrong guesses lock it for a while, doubling each time after the fifth. */
	verify(pin: unknown) {
		const wait = this.lockedUntil - this.now();
		if (wait > 0)
			throw new AppError(429, `Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.`);
		const stored = this.db.select().from(meta).where(eq(meta.key, KEY)).get()?.value;
		if (!stored) return true;
		const [, salt, expected] = stored.split('$');
		const given = typeof pin === 'string' && /^\d{1,8}$/.test(pin) ? pin : '';
		const actual = scryptSync(given, Buffer.from(salt, 'base64'), 32);
		if (timingSafeEqual(actual, Buffer.from(expected, 'base64'))) {
			this.failures = 0;
			return true;
		}
		this.failures++;
		if (this.failures >= 5) this.lockedUntil = this.now() + 30_000 * 2 ** (this.failures - 5);
		throw new AppError(403, 'That PIN is not right.');
	}

	/** Sets or changes the PIN; changing it needs the current one. */
	set(input: unknown) {
		const { pin, current } = parse(
			z.strictObject({ pin: pinSchema, current: z.string().max(8).optional() }),
			input
		);
		if (this.isSet()) this.verify(current ?? '');
		const value = hash(pin);
		this.db
			.insert(meta)
			.values({ key: KEY, value })
			.onConflictDoUpdate({ target: meta.key, set: { value } })
			.run();
	}
}
