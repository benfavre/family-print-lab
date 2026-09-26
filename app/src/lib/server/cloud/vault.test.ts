import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { keyFrom, newRecoveryKey, open, pack, seal, sealedKeyId, unpack } from './vault';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));

describe('encrypted backups', () => {
	it('packs a snapshot folder, seals it, and only the recovery key opens it', () => {
		const from = tmp();
		fs.writeFileSync(path.join(from, 'printlab.db'), 'database bytes');
		fs.mkdirSync(path.join(from, 'models', 'm1'), { recursive: true });
		fs.writeFileSync(path.join(from, 'models', 'm1', 'v1.stl'), Buffer.alloc(5000, 7));

		const key = newRecoveryKey();
		expect(key).toMatch(/^([A-HJKMNP-TV-Z2-9]{4}-){7}[A-HJKMNP-TV-Z2-9]{4}$/);
		const sealed = seal(pack(from), key);
		expect(sealed.includes(Buffer.from('database bytes'))).toBe(false);
		expect(sealedKeyId(sealed)).toBe(keyFrom(key).id);

		// Typed with spaces and in lower case still works.
		const to = tmp();
		expect(unpack(open(sealed, key.toLowerCase().replaceAll('-', ' ')), to)).toBe(2);
		expect(fs.readFileSync(path.join(to, 'printlab.db'), 'utf8')).toBe('database bytes');
		expect(fs.readFileSync(path.join(to, 'models', 'm1', 'v1.stl')).length).toBe(5000);

		expect(() => open(sealed, newRecoveryKey())).toThrow(/does not open/);
		const tampered = Buffer.from(sealed);
		tampered[40] ^= 1;
		expect(() => open(tampered, key)).toThrow(/damaged/);
		expect(() => keyFrom('1234')).toThrow(/not a recovery key/);
	});

	it('never writes outside the target folder', () => {
		const name = Buffer.from('../escape.txt');
		const head = Buffer.alloc(2 + name.length + 8);
		head.writeUInt16BE(name.length, 0);
		name.copy(head, 2);
		head.writeBigUInt64BE(1n, 2 + name.length);
		const evil = gzipSync(Buffer.concat([Buffer.from('PLPACK1\n'), head, Buffer.from('x')]));
		const dir = tmp();
		expect(() => unpack(evil, dir)).toThrow(/damaged/);
		expect(fs.existsSync(path.join(dir, '..', 'escape.txt'))).toBe(false);
	});
});
