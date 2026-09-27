// Password and PIN hashing: scrypt (N=2^15, r=8, p=1) with a 16-byte random salt, compared in
// constant time. The parameters are stored with the hash so they can be raised later.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

function derive(secret: string, salt: Buffer, o: { N: number; r: number; p: number }) {
	// scrypt needs 128·N·r bytes; the default 32 MiB limit is exactly that for N=2^15, r=8, so raise it.
	const options: ScryptOptions = { ...o, maxmem: 256 * o.N * o.r };
	return new Promise<Buffer>((resolve, reject) =>
		scrypt(secret.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) =>
			error ? reject(error) : resolve(key)
		)
	);
}

/** `scrypt$N$r$p$salt$hash` (base64). `cost` (N) is lowered only by tests, to keep them quick. */
export async function hashSecret(secret: string, cost = N): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(secret, salt, { N: cost, r: R, p: P });
	return ['scrypt', cost, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Whether `secret` matches `stored`; false for anything malformed. */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
	const [kind, n, r, p, salt, expected] = stored.split('$');
	if (kind !== 'scrypt' || !salt || !expected) return false;
	const want = Buffer.from(expected, 'base64');
	const params = { N: Number(n), r: Number(r), p: Number(p) };
	if (![params.N, params.r, params.p].every((v) => Number.isInteger(v) && v > 0)) return false;
	const got = await derive(secret, Buffer.from(salt, 'base64'), params).catch(() => null);
	return !!got && got.length === want.length && timingSafeEqual(got, want);
}
