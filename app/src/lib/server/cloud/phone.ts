// The household phone key (protocol v2, docs/cloud-protocol.md). A random 32-byte key that lives on
// this computer (in meta, so encrypted backups carry it) and on the family's phones (shown as a QR
// code behind the parent PIN), never in Print Lab Cloud. Two subkeys come from it with HKDF-SHA256:
// one seals camera pictures and printer status for the phone (AES-256-GCM), the other lets the phone
// sign pause/resume/stop commands (HMAC-SHA256), so the cloud can relay them but not forge them.
//
// Sealed format, like vault.ts: "PLS1" | key id (8 bytes) | IV (12 bytes) | ciphertext | tag (16 bytes).
// The phone opens it with WebCrypto (Print Lab Cloud's public/js/remote.js).
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	hkdfSync,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';

const MAGIC = Buffer.from('PLS1');
const SALT = 'family-print-lab';
/** How far a command's time may be from ours (clock drift and relay delay included). */
export const CONTROL_WINDOW = 2 * 60_000;
export const REMOTE_ACTIONS = ['pause', 'resume', 'stop', 'dispatch'] as const;
export type RemoteAction = (typeof REMOTE_ACTIONS)[number];

export class PhoneKeyError extends Error {}

export function newPhoneKey() {
	return randomBytes(32);
}

/** The key's id: the first 8 bytes of SHA-256 of the key, as hex. It says which key sealed what. */
export function phoneKeyId(key: Buffer) {
	return createHash('sha256').update(key).digest().subarray(0, 8).toString('hex');
}

export interface PhoneKeys {
	id: string;
	seal: Buffer;
	mac: Buffer;
}

export function phoneKeys(key: Buffer): PhoneKeys {
	if (key.length !== 32) throw new PhoneKeyError('A phone key is 32 bytes.');
	return {
		id: phoneKeyId(key),
		seal: Buffer.from(hkdfSync('sha256', key, SALT, 'phone seal v1', 32)),
		mac: Buffer.from(hkdfSync('sha256', key, SALT, 'phone mac v1', 32))
	};
}

export interface ControlFields {
	commandId: string;
	printerId: string;
	action: RemoteAction;
	at: number;
	/** Only for `dispatch`. */
	queueItemId?: string;
}

/** What the phone signs: `commandId|printerId|action|at`, plus `|queueItemId` for `dispatch`. */
export function controlMessage(c: ControlFields) {
	const base = `${c.commandId}|${c.printerId}|${c.action}|${c.at}`;
	return c.action === 'dispatch' ? `${base}|${c.queueItemId ?? ''}` : base;
}

/** The command's MAC as lower-case hex (what the phone computes with WebCrypto). */
export function controlMac(keys: PhoneKeys, c: ControlFields) {
	return createHmac('sha256', keys.mac).update(controlMessage(c)).digest('hex');
}

export function verifyControlMac(keys: PhoneKeys, c: ControlFields, mac: unknown) {
	if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/i.test(mac)) return false;
	return timingSafeEqual(Buffer.from(controlMac(keys, c), 'hex'), Buffer.from(mac, 'hex'));
}

export function seal(keys: PhoneKeys, plain: Buffer, aad: string): Buffer {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', keys.seal, iv);
	cipher.setAAD(Buffer.from(aad));
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	return Buffer.concat([MAGIC, Buffer.from(keys.id, 'hex'), iv, body, cipher.getAuthTag()]);
}

/** Opens a sealed message (tests; the phone does the same in the browser). */
export function open(keys: PhoneKeys, sealed: Buffer, aad: string): Buffer {
	if (sealed.length < 40 || !sealed.subarray(0, 4).equals(MAGIC))
		throw new PhoneKeyError('Not a sealed message.');
	if (sealed.subarray(4, 12).toString('hex') !== keys.id)
		throw new PhoneKeyError('Sealed with another phone key.');
	const decipher = createDecipheriv('aes-256-gcm', keys.seal, sealed.subarray(12, 24));
	decipher.setAAD(Buffer.from(aad));
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	try {
		return Buffer.concat([
			decipher.update(sealed.subarray(24, sealed.length - 16)),
			decipher.final()
		]);
	} catch {
		throw new PhoneKeyError('The message was changed or does not belong here.');
	}
}

/**
 * A picture for the phone: u16 header length | JSON header { capturedAt, printerId, type } | JPEG.
 * The header repeats what the additional data binds, so the phone can show when it was taken.
 */
export function sealSnapshot(
	keys: PhoneKeys,
	o: { requestId: string; printerId: string; capturedAt: number; jpeg: Buffer }
) {
	const header = Buffer.from(
		JSON.stringify({ capturedAt: o.capturedAt, printerId: o.printerId, type: 'image/jpeg' })
	);
	const length = Buffer.alloc(2);
	length.writeUInt16BE(header.length);
	return seal(
		keys,
		Buffer.concat([length, header, o.jpeg]),
		snapshotAad(o.requestId, o.printerId, o.capturedAt)
	);
}

export const snapshotAad = (requestId: string, printerId: string, capturedAt: number) =>
	`${requestId}|${printerId}|${capturedAt}`;

export function openSnapshot(
	keys: PhoneKeys,
	sealed: Buffer,
	o: { requestId: string; printerId: string; capturedAt: number }
) {
	const plain = open(keys, sealed, snapshotAad(o.requestId, o.printerId, o.capturedAt));
	const length = plain.readUInt16BE(0);
	const header = JSON.parse(plain.subarray(2, 2 + length).toString()) as {
		capturedAt: number;
		printerId: string;
		type: string;
	};
	return { header, jpeg: plain.subarray(2 + length) };
}

/** The phone key as the QR code carries it: base64url, in the URL fragment (never sent to a server). */
export const encodePhoneKey = (key: Buffer) => key.toString('base64url');
