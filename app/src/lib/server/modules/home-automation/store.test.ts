// Saved plugs: one per printer, what each kind needs, versioned edits, secrets kept apart.
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../db';
import { printers } from '../../db/schema';
import { PlugStore, plugView } from './store';

function store() {
	const db = openDatabase(':memory:');
	db.insert(printers)
		.values({
			id: 'p1',
			name: 'X2D',
			model: 'N6',
			host: '192.168.1.20',
			serial: 'SERIAL1',
			accessCode: '12345678'
		})
		.run();
	let changes = 0;
	const s = new PlugStore(db, () => changes++);
	return { db, s, changes: () => changes };
}

describe('PlugStore', () => {
	it('adds one plug per printer with the defaults, and says what a kind needs', () => {
		const { s, changes } = store();
		expect(() => s.create({ printerId: 'p1', kind: 'tasmota', config: {} })).toThrow(
			/address of the plug/
		);
		expect(() =>
			s.create({
				printerId: 'p1',
				kind: 'homeassistant',
				config: { url: 'http://ha:8123', entityId: 'switch.p' }
			})
		).toThrow(/long-lived access token/);
		expect(() =>
			s.create({ printerId: 'p1', kind: 'webhook', config: { onUrl: 'http://x/on' } })
		).toThrow(/both addresses/);
		expect(() =>
			s.create({ printerId: 'p1', kind: 'tasmota', config: { url: 'ftp://x' } })
		).toThrow(/http:\/\//);
		expect(() =>
			s.create({ printerId: 'nope', kind: 'tasmota', config: { url: 'http://x' } })
		).toThrow(/no longer exists/);
		const plug = s.create({
			printerId: 'p1',
			kind: 'tasmota',
			config: { url: 'http://192.168.1.30', password: 'pw' }
		});
		expect(plug).toMatchObject({
			autoOn: true,
			autoOff: false,
			cooldownMinutes: 10,
			offBelowNozzle: 50,
			version: 1
		});
		expect(changes()).toBe(1);
		expect(() =>
			s.create({ printerId: 'p1', kind: 'shelly', config: { url: 'http://x' } })
		).toThrow(/already has a plug/);
		expect(plugView(plug).config).toEqual({
			url: 'http://192.168.1.30',
			hasPassword: true,
			hasToken: false
		});
	});

	it('edits with versions, drops settings another kind does not use, and goes with its printer', () => {
		const { db, s } = store();
		const plug = s.create({
			printerId: 'p1',
			kind: 'tasmota',
			config: { url: 'http://192.168.1.30', password: 'pw' }
		});
		expect(() => s.update(plug.id, { version: 9, autoOff: true })).toThrow(
			/changed this plug meanwhile/
		);
		const ha = s.update(plug.id, {
			version: 1,
			kind: 'homeassistant',
			config: { entityId: 'switch.printer', token: 'tok' },
			autoOff: true,
			cooldownMinutes: 5
		});
		expect(ha.config).toEqual({
			url: 'http://192.168.1.30',
			entityId: 'switch.printer',
			token: 'tok'
		});
		expect(ha).toMatchObject({ version: 2, autoOff: true, cooldownMinutes: 5 });
		db.delete(printers).run();
		expect(s.list()).toEqual([]);
	});

	it('keeps a saved secret only for the address it was saved for', () => {
		const { s } = store();
		const plug = s.create({
			printerId: 'p1',
			kind: 'homeassistant',
			config: { url: 'http://ha.local:8123', entityId: 'switch.p', token: 'long-lived' }
		});
		// Pointing it at another server without typing the token again would send the token there.
		expect(() =>
			s.update(plug.id, { version: 1, config: { url: 'http://evil.example:8123' } })
		).toThrow(/address changed, so enter the access token again/);
		expect(s.get(plug.id)!.config).toMatchObject({
			url: 'http://ha.local:8123',
			token: 'long-lived'
		});
		// Same server, other spelling of the path: kept.
		const same = s.update(plug.id, { version: 1, config: { url: 'http://ha.local:8123/' } });
		expect(same.config.token).toBe('long-lived');
		// A new address with the token typed again is fine.
		const moved = s.update(plug.id, {
			version: 2,
			config: { url: 'http://192.168.1.9:8123', token: 'again' }
		});
		expect(moved.config).toMatchObject({ url: 'http://192.168.1.9:8123', token: 'again' });
		const tas = s.update(plug.id, {
			version: 3,
			kind: 'tasmota',
			config: { url: 'http://192.168.1.30', password: 'pw' }
		});
		expect(() =>
			s.update(plug.id, { version: tas.version, config: { url: 'http://192.168.1.31' } })
		).toThrow(/enter the password again/);
		// Dropping the password on purpose is always allowed.
		const cleared = s.update(plug.id, {
			version: tas.version,
			config: { url: 'http://192.168.1.31', password: null }
		});
		expect(cleared.config).toEqual({ url: 'http://192.168.1.31' });
	});
});
