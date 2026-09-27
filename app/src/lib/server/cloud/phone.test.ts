import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	controlMac,
	controlMessage,
	newPhoneKey,
	open,
	openSnapshot,
	phoneKeys,
	seal,
	sealSnapshot,
	verifyControlMac
} from './phone';

// A fixed key, so the derivation is pinned (the phone's WebCrypto code must derive the same).
const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

describe('the phone key', () => {
	it('derives two subkeys with HKDF-SHA256 and a short id', () => {
		const keys = phoneKeys(KEY);
		expect(keys.id).toBe(createHash('sha256').update(KEY).digest().subarray(0, 8).toString('hex'));
		expect(keys.seal).toEqual(
			Buffer.from(hkdfSync('sha256', KEY, 'family-print-lab', 'phone seal v1', 32))
		);
		expect(keys.mac).toEqual(
			Buffer.from(hkdfSync('sha256', KEY, 'family-print-lab', 'phone mac v1', 32))
		);
		expect(keys.seal.equals(keys.mac)).toBe(false);
		expect(newPhoneKey()).toHaveLength(32);
		expect(() => phoneKeys(Buffer.alloc(16))).toThrow(/32 bytes/);
	});

	it('signs commands over commandId|printerId|action|at, and refuses changed ones', () => {
		const keys = phoneKeys(KEY);
		const c = { commandId: 'c1', printerId: 'p1', action: 'pause' as const, at: 1_700_000_000_000 };
		expect(controlMessage(c)).toBe('c1|p1|pause|1700000000000');
		const mac = controlMac(keys, c);
		expect(mac).toBe(
			createHmac('sha256', keys.mac).update('c1|p1|pause|1700000000000').digest('hex')
		);
		expect(verifyControlMac(keys, c, mac)).toBe(true);
		expect(verifyControlMac(keys, c, mac.toUpperCase())).toBe(true);
		expect(verifyControlMac(keys, { ...c, action: 'stop' }, mac)).toBe(false);
		expect(verifyControlMac(keys, { ...c, printerId: 'p2' }, mac)).toBe(false);
		expect(verifyControlMac(keys, c, 'nope')).toBe(false);
		expect(verifyControlMac(phoneKeys(newPhoneKey()), c, mac)).toBe(false);
		expect(controlMessage({ ...c, action: 'dispatch', queueItemId: 'q1' })).toBe(
			'c1|p1|dispatch|1700000000000|q1'
		);
	});

	it('seals so only the phone key opens it, bound to its additional data', () => {
		const keys = phoneKeys(KEY);
		const sealed = seal(keys, Buffer.from('hello'), 'printers|d1');
		expect(sealed.subarray(0, 4).toString()).toBe('PLS1');
		expect(sealed.subarray(4, 12).toString('hex')).toBe(keys.id);
		expect(sealed).toHaveLength(4 + 8 + 12 + 5 + 16);
		expect(open(keys, sealed, 'printers|d1').toString()).toBe('hello');
		expect(() => open(keys, sealed, 'printers|d2')).toThrow(/changed/);
		expect(() => open(phoneKeys(newPhoneKey()), sealed, 'printers|d1')).toThrow(/another/);
	});

	it('seals a snapshot with its request, printer and time', () => {
		const keys = phoneKeys(KEY);
		const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
		const o = { requestId: 'r1', printerId: 'p1', capturedAt: 1234 };
		const sealed = sealSnapshot(keys, { ...o, jpeg });
		const opened = openSnapshot(keys, sealed, o);
		expect(opened.jpeg).toEqual(jpeg);
		expect(opened.header).toEqual({ capturedAt: 1234, printerId: 'p1', type: 'image/jpeg' });
		// The cloud cannot pass it off as another printer, request or time.
		expect(() => openSnapshot(keys, sealed, { ...o, printerId: 'p2' })).toThrow();
		expect(() => openSnapshot(keys, sealed, { ...o, requestId: 'r2' })).toThrow();
		expect(() => openSnapshot(keys, sealed, { ...o, capturedAt: 1235 })).toThrow();
	});
});
