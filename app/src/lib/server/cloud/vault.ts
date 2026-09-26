// Encrypted cloud backups. A snapshot folder (the database and model files) is packed into one file,
// compressed, and sealed with AES-256-GCM under a key derived from a recovery key that only the
// family has. Print Lab Cloud stores the sealed file and cannot read it. Format:
//   "PLB1" | key id (8 bytes) | IV (12 bytes) | ciphertext | GCM tag (16 bytes)
// and inside, gzipped: "PLPACK1\n" then, per file, u16 name length | name | u64 size | bytes.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const MAGIC = Buffer.from('PLB1');
const PACK = Buffer.from('PLPACK1\n');
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U
export const MAX_BACKUP = 95_000_000;

export class VaultError extends Error {}

/** 32 characters from a 30-letter alphabet (about 157 bits), shown in groups of four. */
export function newRecoveryKey() {
	let chars = '';
	while (chars.length < 32)
		for (const b of randomBytes(40))
			// 240 is the largest multiple of 30 under 256: no letter is likelier than another.
			if (b < 240 && chars.length < 32) chars += ALPHABET[b % ALPHABET.length];
	return chars.match(/.{4}/g)!.join('-');
}

export const normalizeKey = (key: string) => key.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The AES key, and a short id the cloud stores so a wrong key can be named before decrypting. */
export function keyFrom(recoveryKey: string) {
	const ikm = normalizeKey(recoveryKey);
	if (ikm.length !== 32 || [...ikm].some((c) => !ALPHABET.includes(c)))
		throw new VaultError('That is not a recovery key (32 letters and digits, in groups of 4).');
	const key = Buffer.from(hkdfSync('sha256', ikm, 'family-print-lab', 'backup v1', 32));
	const id = createHash('sha256').update(key).digest().subarray(0, 8);
	return { key, id: id.toString('hex') };
}

/** Every file under `dir`, relative paths with forward slashes. */
function files(dir: string, base = dir): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return files(full, base);
		return e.isFile() ? [path.relative(base, full).split(path.sep).join('/')] : [];
	});
}

export function pack(dir: string): Buffer {
	const parts: Buffer[] = [PACK];
	for (const name of files(dir)) {
		const data = fs.readFileSync(path.join(dir, name));
		const nameBytes = Buffer.from(name);
		const head = Buffer.alloc(2 + nameBytes.length + 8);
		head.writeUInt16BE(nameBytes.length, 0);
		nameBytes.copy(head, 2);
		head.writeBigUInt64BE(BigInt(data.length), 2 + nameBytes.length);
		parts.push(head, data);
	}
	return gzipSync(Buffer.concat(parts), { level: 6 });
}

/** Writes a pack's files under `dir`, refusing any name that would land outside it. */
export function unpack(packed: Buffer, dir: string) {
	const raw = gunzipSync(packed, { maxOutputLength: 2_000_000_000 });
	if (!raw.subarray(0, PACK.length).equals(PACK)) throw new VaultError('Not a backup.');
	let at = PACK.length;
	const root = path.resolve(dir);
	let count = 0;
	while (at < raw.length) {
		const nameLength = raw.readUInt16BE(at);
		const name = raw.subarray(at + 2, at + 2 + nameLength).toString();
		const size = Number(raw.readBigUInt64BE(at + 2 + nameLength));
		const start = at + 2 + nameLength + 8;
		const target = path.resolve(root, name);
		if (!target.startsWith(root + path.sep) || start + size > raw.length)
			throw new VaultError('This backup is damaged.');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, raw.subarray(start, start + size));
		at = start + size;
		count++;
	}
	return count;
}

export function seal(plain: Buffer, recoveryKey: string): Buffer {
	const { key, id } = keyFrom(recoveryKey);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(MAGIC);
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	return Buffer.concat([MAGIC, Buffer.from(id, 'hex'), iv, body, cipher.getAuthTag()]);
}

/** The key id a sealed backup was made with (to say "wrong key" before trying). */
export function sealedKeyId(sealed: Buffer) {
	if (sealed.length < 40 || !sealed.subarray(0, 4).equals(MAGIC))
		throw new VaultError('This is not a Family Print Lab backup.');
	return sealed.subarray(4, 12).toString('hex');
}

export function open(sealed: Buffer, recoveryKey: string): Buffer {
	const { key, id } = keyFrom(recoveryKey);
	if (sealedKeyId(sealed) !== id)
		throw new VaultError('That recovery key does not open this backup.');
	const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(12, 24));
	decipher.setAAD(MAGIC);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	try {
		return Buffer.concat([
			decipher.update(sealed.subarray(24, sealed.length - 16)),
			decipher.final()
		]);
	} catch {
		throw new VaultError('This backup is damaged or was changed.');
	}
}
