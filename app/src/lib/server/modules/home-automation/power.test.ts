// Power rules: never cut power while printing or while the nozzle is hot, wait for the cool-down and
// the queue, and the wake-up hook's waiting, time limit and stop signal.
import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '$lib/shared/printers/status';
import type { BambuPrinter } from '../../printer/bambu';
import { offBlocker, offDecision, PowerController } from './power';
import type { Plug } from './store';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const idle = (nozzle: number | null) => emptySnapshot({ gcodeState: 'FINISH', nozzle });

describe('offBlocker', () => {
	const base = { connected: true, lastSeen: ago(1000), offBelowNozzle: 50 };
	it.each([
		['printing', { snapshot: emptySnapshot({ gcodeState: 'RUNNING', nozzle: 30 }) }, /printing/],
		['paused', { snapshot: emptySnapshot({ gcodeState: 'PAUSE', nozzle: 30 }) }, /printing/],
		['preparing', { snapshot: emptySnapshot({ gcodeState: 'PREPARE', nozzle: 30 }) }, /printing/],
		['hot nozzle', { snapshot: idle(180) }, /still 180 °C/],
		['at the threshold', { snapshot: idle(50) }, /still 50 °C/],
		['no temperature', { snapshot: idle(null) }, /how hot/],
		['no report', { snapshot: null }, /not reported/],
		[
			'the other nozzle is hot',
			{
				snapshot: emptySnapshot({
					gcodeState: 'IDLE',
					nozzle: 30,
					nozzles: [
						{ id: 0, temp: 30, target: 0, diameter: 0.4, type: null, activeTray: null, wear: null },
						{ id: 1, temp: 120, target: 0, diameter: 0.4, type: null, activeTray: null, wear: null }
					]
				})
			},
			/still 120 °C/
		],
		// Went quiet a moment ago while hot: still counts.
		[
			'offline but recently hot',
			{ connected: false, lastSeen: ago(60_000), snapshot: idle(200) },
			/still 200/
		]
	])('keeps power on: %s', (_, over, reason) => {
		expect(offBlocker({ ...base, ...over }, NOW)).toMatch(reason);
	});

	it('allows it when idle and cool, or off and silent for a while', () => {
		expect(offBlocker({ ...base, snapshot: idle(49) }, NOW)).toBeNull();
		expect(
			offBlocker({ ...base, connected: false, lastSeen: ago(3600_000), snapshot: idle(200) }, NOW)
		).toBeNull();
		expect(
			offBlocker({ ...base, connected: false, lastSeen: null, snapshot: null }, NOW)
		).toBeNull();
	});
});

describe('offDecision after a print', () => {
	const base = {
		endedAt: NOW - 11 * 60_000,
		cooldownMinutes: 10,
		connected: true,
		snapshot: idle(40),
		lastSeen: ago(1000),
		offBelowNozzle: 50,
		queueDue: false
	};
	it.each([
		['cool, idle, cooled down, nothing lined up', {}, { action: 'off' }],
		[
			'cool-down not over',
			{ endedAt: NOW - 4 * 60_000 },
			{ action: 'wait', reason: 'Cooling down (6 min).' }
		],
		['nozzle still hot', { snapshot: idle(90) }, { action: 'wait' }],
		[
			'queue has the next print',
			{ queueDue: true },
			{ action: 'wait', reason: 'Another print is lined up.' }
		],
		['printer not reporting', { connected: false }, { action: 'wait' }],
		[
			'a new print started',
			{ snapshot: emptySnapshot({ gcodeState: 'RUNNING' }) },
			{ action: 'cancel' }
		],
		['waited six hours', { endedAt: NOW - 7 * 3600_000, snapshot: idle(90) }, { action: 'cancel' }]
	])('%s', (_, over, expected) => {
		expect(offDecision({ ...base, ...over }, NOW)).toMatchObject(expected);
	});
});

/** A connection stand-in: connects `bootMs` after start() once the plug is on. */
function fakePrinter() {
	const p = {
		name: 'Test X2D',
		connected: false,
		lastSeen: null as string | null,
		snapshot: idle(25),
		powered: false,
		starts: 0,
		stop() {
			p.connected = false;
		},
		start() {
			p.starts++;
			if (p.powered)
				setTimeout(() => {
					p.connected = true;
					p.lastSeen = new Date().toISOString();
				}, 20);
		}
	};
	return p;
}

function controller(o: { plug?: Partial<Plug>; timeoutMs?: number } = {}) {
	const printer = fakePrinter();
	const switches: boolean[] = [];
	const events: string[] = [];
	const plug = {
		id: 'plug',
		printerId: 'p1',
		kind: 'webhook',
		config: {},
		autoOn: true,
		autoOff: true,
		cooldownMinutes: 0,
		offBelowNozzle: 50,
		version: 1,
		createdAt: '',
		updatedAt: '',
		...o.plug
	} as Plug;
	const power = new PowerController({
		plugFor: (id) => (id === 'p1' ? plug : undefined),
		printer: (id) => (id === 'p1' ? (printer as unknown as BambuPrinter) : undefined),
		queueDue: () => false,
		changed: (_, what) => what && events.push(`${what.on ? 'on' : 'off'}:${what.reason}`),
		log: () => {},
		client: () => ({
			async set(on) {
				switches.push(on);
				printer.powered = on;
			},
			read: async () => printer.powered
		}),
		timings: { onlineTimeoutMs: o.timeoutMs ?? 2000, pollMs: 10, retryMs: 30, offCheckMs: 20 }
	});
	return { power, printer, switches, events, plug };
}

describe('PowerController', () => {
	it('ensureOn switches the plug on and waits until the printer reports', async () => {
		const { power, printer, switches, events } = controller();
		await power.ensureOn('p1');
		expect(switches).toEqual([true]);
		expect(printer.connected).toBe(true);
		expect(printer.starts).toBeGreaterThan(0);
		expect(events).toEqual(['on:print']);
		// Already online, no plug, or no auto power-on: nothing happens.
		await power.ensureOn('p1');
		await power.ensureOn('other');
		expect(switches).toEqual([true]);
		const manual = controller({ plug: { autoOn: false } });
		await manual.power.ensureOn('p1');
		expect(manual.switches).toEqual([]);
	});

	it('gives up after the time limit with a plain message', async () => {
		const { power, printer } = controller({ timeoutMs: 150 });
		printer.start = () => {}; // never comes back
		await expect(power.ensureOn('p1')).rejects.toThrow(/did not come online within 0 seconds/);
		expect(power.state('p1').note).toMatch(/did not come online/);
	});

	it('stops waiting when the send is stopped', async () => {
		const { power, printer } = controller({ timeoutMs: 60_000 });
		printer.start = () => {};
		const stop = new AbortController();
		setTimeout(() => stop.abort(), 50);
		await expect(power.ensureOn('p1', { signal: stop.signal })).rejects.toThrow('Stopped');
	});

	it('refuses to switch off by hand while printing or hot', async () => {
		const { power, printer, switches } = controller();
		printer.connected = true;
		printer.lastSeen = new Date().toISOString();
		printer.snapshot = emptySnapshot({ gcodeState: 'RUNNING', nozzle: 220 });
		await expect(power.switch('p1', false, 'manual')).rejects.toThrow(/printing/);
		printer.snapshot = idle(120);
		await expect(power.switch('p1', false, 'manual')).rejects.toThrow(/still 120 °C/);
		printer.snapshot = idle(30);
		await power.switch('p1', false, 'manual');
		expect(switches).toEqual([false]);
	});

	it('switches off after a print once cool, and not when another print starts', async () => {
		const { power, printer, switches, events } = controller();
		printer.connected = true;
		printer.powered = true;
		printer.lastSeen = new Date().toISOString();
		printer.snapshot = idle(200);
		power.printEnded('p1');
		await new Promise((r) => setTimeout(r, 80));
		expect(switches).toEqual([]);
		expect(power.state('p1').note).toMatch(/Switching off later: The nozzle is still 200/);
		printer.snapshot = idle(40);
		await new Promise((r) => setTimeout(r, 80));
		expect(switches).toEqual([false]);
		expect(events).toEqual(['off:auto']);
		expect(power.pending()).toEqual([]);

		printer.snapshot = idle(200);
		power.printEnded('p1');
		printer.snapshot = emptySnapshot({ gcodeState: 'RUNNING', nozzle: 220 });
		await new Promise((r) => setTimeout(r, 80));
		expect(power.pending()).toEqual([]);
		expect(switches).toEqual([false]);
	});

	it('does nothing after a print without auto power-off', () => {
		const { power } = controller({ plug: { autoOff: false } });
		power.printEnded('p1');
		expect(power.pending()).toEqual([]);
	});
});
