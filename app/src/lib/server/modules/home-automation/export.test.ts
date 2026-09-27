// The metrics text is valid Prometheus exposition format, and the tokens and address checks hold.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type PrinterStatus } from '$lib/shared/printers/status';
import { haPrinter, renderMetrics } from './export';
import { allowed, bearer, hashToken, isLoopback, newToken, tokenMatches } from './access';

const printers: PrinterStatus[] = [
	{
		configured: true,
		id: 'p1',
		name: 'Mum\'s "fast" X2D\\',
		model: 'N6',
		connected: true,
		printing: true,
		state: emptySnapshot({
			gcodeState: 'RUNNING',
			percent: 50,
			remainingMinutes: 12,
			layer: 30,
			totalLayers: 60,
			nozzle: 220,
			nozzleTarget: 220,
			nozzles: [
				{ id: 0, temp: 220, target: 220, diameter: 0.4, type: null, activeTray: 0, wear: null },
				{ id: 1, temp: 140, target: 0, diameter: 0.4, type: null, activeTray: null, wear: null }
			],
			bed: 55.25,
			bedTarget: 55,
			chamber: 31,
			ams: [
				{
					unit: 'A',
					id: 0,
					humidity: null,
					humidityIndex: 2,
					humidityPercent: 23,
					temp: 26.5,
					trays: [],
					model: 'AMS 2 Pro',
					drying: null,
					serial: null,
					firmware: null,
					nozzle: 0,
					dryStatus: null
				}
			]
		})
	},
	{ configured: true, id: 'p2', name: 'Loft A1', model: 'N2S', connected: false, state: null }
];

// One line of the text format: comment, or `name{labels} value`.
const LINE =
	/^(# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .*|[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\\n]|\\["\\n])*",?)*\})? (-?[0-9.e+-]+|NaN|[+-]Inf))$/;

describe('metrics', () => {
	const text = renderMetrics({
		printers,
		jobs: { Queued: 2, Printing: 1, Succeeded: 5, Failed: 0, Cancelled: 1 },
		power: { p1: true, p2: null }
	});

	it('is valid exposition text: every line parses, each metric is typed once, ends with a newline', () => {
		expect(text.endsWith('\n')).toBe(true);
		const lines = text.trimEnd().split('\n');
		for (const line of lines) expect(line).toMatch(LINE);
		const types = lines.filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]);
		expect(new Set(types).size).toBe(types.length);
		// Samples follow their TYPE line.
		let current = '';
		for (const line of lines) {
			if (line.startsWith('# TYPE ')) current = line.split(' ')[2];
			else if (!line.startsWith('#')) expect(line.split(/[{ ]/)[0]).toBe(current);
		}
	});

	it('has state, temperatures, progress, AMS humidity and job counts', () => {
		const who = 'printer_id="p1",printer="Mum\'s \\"fast\\" X2D\\\\",model="N6"';
		expect(text).toContain(`printlab_printer_up{${who}} 1`);
		expect(text).toContain('printlab_printer_up{printer_id="p2",printer="Loft A1",model="N2S"} 0');
		expect(text).toContain(`printlab_printer_state{${who},state="running"} 1`);
		expect(text).toContain(`printlab_nozzle_temperature_celsius{${who},nozzle="1"} 140`);
		expect(text).toContain(`printlab_bed_temperature_celsius{${who}} 55.25`);
		expect(text).toContain(`printlab_print_progress_percent{${who}} 50`);
		expect(text).toContain(`printlab_print_remaining_seconds{${who}} 720`);
		expect(text).toContain(`printlab_ams_humidity_percent{${who},ams="A"} 23`);
		expect(text).toContain(`printlab_plug_on{${who}} 1`);
		expect(text).toContain('printlab_jobs{status="queued"} 2');
		// An offline printer has no stale readings.
		expect(text).not.toMatch(/printlab_bed_temperature_celsius\{printer_id="p2"/);
	});

	it('the Home Assistant shape is flat and has no addresses or serials', () => {
		expect(haPrinter(printers[0], true)).toMatchObject({
			id: 'p1',
			state: 'running',
			progress: 50,
			bed_temp: 55.3,
			ams: [{ unit: 'A', humidity_percent: 23, humidity_level: 2, temp: 26.5 }],
			power: true
		});
		expect(haPrinter(printers[1])).toMatchObject({ online: false, state: 'offline', power: null });
	});
});

describe('access', () => {
	it('tokens are random, stored as SHA-256 and compared by hash', () => {
		const a = newToken();
		expect(a.token).not.toBe(newToken().token);
		expect(a.hash).toBe(hashToken(a.token));
		expect(tokenMatches(a.token, a.hash)).toBe(true);
		expect(tokenMatches(`${a.token}x`, a.hash)).toBe(false);
		expect(tokenMatches(a.token, null)).toBe(false);
		expect(tokenMatches(null, a.hash)).toBe(false);
		expect(tokenMatches(a.token, 'not-a-hash')).toBe(false);
	});

	it('loopback means the socket address', () => {
		for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.1.2.3'])
			expect(isLoopback(a)).toBe(true);
		for (const a of ['192.168.1.2', '::ffff:10.0.0.1', '', null, '1127.0.0.1'])
			expect(isLoopback(a)).toBe(false);
		expect(bearer('Bearer abc')).toBe('abc');
		expect(bearer('Basic abc')).toBeNull();
		const req = (
			from: string | Error,
			headers: Record<string, string> = {},
			locals: object = {}
		) => ({
			getClientAddress: () => {
				if (from instanceof Error) throw from;
				return from;
			},
			request: new Request('http://x/metrics', { headers }),
			locals
		});
		const { token, hash } = newToken();
		expect(allowed(req('127.0.0.1'), null)).toBe(true);
		expect(
			allowed(req('10.0.0.2', { 'x-forwarded-for': '127.0.0.1', host: 'localhost' }), hash)
		).toBe(false);
		expect(allowed(req('10.0.0.2', { authorization: `Bearer ${token}` }), hash)).toBe(true);
		expect(allowed(req(new Error('no address')), hash)).toBe(false);
		// A lan-auth session counts; a kid-mode browser does not.
		expect(allowed(req('10.0.0.2', {}, { session: { id: 's' } }), null)).toBe(true);
		expect(allowed(req('10.0.0.2', {}, { session: { id: 's' }, kid: { id: 'k' } }), null)).toBe(
			false
		);
	});
});
