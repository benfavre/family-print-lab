import { describe, expect, it } from 'vitest';
import { hashSecret, verifySecret } from './password';

describe('password hashing', () => {
	it('stores scrypt N=2^15, r=8, p=1 with a 16-byte salt, and verifies', async () => {
		const stored = await hashSecret('correct horse');
		const [kind, n, r, p, salt, key] = stored.split('$');
		expect([kind, n, r, p]).toEqual(['scrypt', '32768', '8', '1']);
		expect(Buffer.from(salt, 'base64')).toHaveLength(16);
		expect(Buffer.from(key, 'base64')).toHaveLength(32);
		expect(await verifySecret('correct horse', stored)).toBe(true);
		expect(await verifySecret('correct horse ', stored)).toBe(false);
		expect(await verifySecret('', stored)).toBe(false);
	});

	it('salts every hash differently', async () => {
		expect(await hashSecret('1234')).not.toBe(await hashSecret('1234'));
	});

	it('refuses malformed hashes instead of throwing', async () => {
		for (const bad of [
			'',
			'plain',
			'scrypt$x$8$1$abc$def',
			'bcrypt$1$2$3$4$5',
			'scrypt$32768$8$1$$',
			'scrypt$3$8$1$c2FsdA==$a2V5'
		])
			expect(await verifySecret('anything', bad)).toBe(false);
	});
});
