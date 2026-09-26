// Protocol conformance: real (or carefully written) printer reports go through mergeReport + parseReport
// and must give the reviewed snapshots in __fixtures__/reports/*.expected.json. Sources and licences:
// __fixtures__/reports/README.md. After a deliberate parser change, regenerate with
// UPDATE_FIXTURES=1 bunx vitest --run src/lib/server/printer/conformance.test.ts and review the diff.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	amsSlotOf,
	mergeReport,
	parseReport,
	parseVersions,
	trayFromSnow,
	trayFromTrayNow,
	type Raw
} from './report';
import { developerMode, firmwareSupport, flagValue, hexFlag } from './flags';
import {
	MODEL_CODES,
	PRINTER_MODELS,
	capabilitiesFor,
	compareFirmware,
	detectModel,
	sameModel,
	type ModelCode
} from '$lib/shared/printers/models';
import { EXT_DEPUTY, EXT_MAIN, type PrinterSnapshot } from '$lib/shared/printers/status';
import { stageName } from '$lib/shared/printers/stages';

const DIR = path.join(import.meta.dirname, '__fixtures__', 'reports');
interface Fixture {
	source: string;
	licence: string;
	model: ModelCode;
	synthetic?: boolean;
	pushall: Raw;
	get_version: Raw;
	deltas?: Raw[];
}
const names = fs
	.readdirSync(DIR)
	.filter((f) => f.endsWith('.json') && !f.endsWith('.expected.json'))
	.map((f) => f.replace(/\.json$/, ''))
	.sort();
const load = (name: string): Fixture =>
	JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const ctx = (f: Fixture) => ({
	model: PRINTER_MODELS[f.model],
	versions: parseVersions(f.get_version),
	accessCodeSet: true
});
const parse = (f: Fixture, raw: Raw) => parseReport(raw, ctx(f));
const fresh = (f: Fixture) => mergeReport({}, structuredClone(f.pushall));

describe('fixtures', () => {
	it('are all here, each with a source, licence and known model', () => {
		expect(names).toEqual(
			expect.arrayContaining([
				'x1c-multi-ams',
				'p1p-no-ams',
				'p1s',
				'a1',
				'a1-mini',
				'h2d',
				'h2d-ext-spool',
				'x2d',
				'p2s',
				'h2s',
				'h2c',
				'h2d-pro',
				'a2l',
				'openbambuapi-pushall',
				'p1-delta-sequence'
			])
		);
		for (const name of names) {
			const f = load(name);
			expect(f.source, name).toBeTruthy();
			expect(f.licence, name).toBeTruthy();
			expect(MODEL_CODES).toContain(f.model);
		}
	});

	for (const name of names)
		it(`${name} parses to the reviewed snapshot`, () => {
			const f = load(name);
			const snapshot = parse(f, fresh(f));
			let afterDeltas: PrinterSnapshot | undefined;
			if (f.deltas) {
				const raw = fresh(f);
				for (const d of f.deltas) mergeReport(raw, structuredClone(d));
				afterDeltas = parse(f, raw);
			}
			const file = path.join(DIR, `${name}.expected.json`);
			if (process.env.UPDATE_FIXTURES) {
				fs.writeFileSync(
					file,
					`${JSON.stringify(afterDeltas ? { ...snapshot, afterDeltas } : snapshot, null, '\t')}\n`
				);
			}
			const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
			const { afterDeltas: expectedAfter, ...expectedSnapshot } = expected;
			expect(snapshot).toEqual(expectedSnapshot);
			if (afterDeltas) expect(afterDeltas).toEqual(expectedAfter);
			// The model is recognised from its own get_version answer.
			const detected = detectModel({ modules: ctx(f).versions });
			expect(detected && sameModel(detected, f.model), `${name} detected as ${detected}`).toBe(
				true
			);
		});

	it('merging a pushall twice changes nothing', () => {
		for (const name of names) {
			const f = load(name);
			const once = parse(f, fresh(f));
			const twice = parse(f, mergeReport(fresh(f), structuredClone(f.pushall)));
			expect(twice, name).toEqual(once);
		}
	});
});

describe('keyed merge (P1/A1 deltas)', () => {
	const x1c = load('x1c-multi-ams');

	it('a delta with one tray keeps the other three', () => {
		const raw = fresh(x1c);
		mergeReport(raw, { ams: { ams: [{ id: '0', tray: [{ id: '1', remain: 12 }] }] } });
		const s = parse(x1c, raw);
		expect(s.ams[0].trays.map((t) => t.type)).toEqual(['PLA', 'PLA', 'PLA', 'PLA']);
		expect(s.ams[0].trays[1].remain).toBe(12);
	});

	it('a delta for AMS unit 1 does not touch unit 0', () => {
		const raw = fresh(x1c);
		const before = parse(x1c, raw).ams[0];
		mergeReport(raw, { ams: { ams: [{ id: '1', humidity: '2' }] } });
		const s = parse(x1c, raw);
		expect(s.ams[0]).toEqual(before);
		expect(s.ams[1].humidityIndex).toBe(2);
		expect(s.ams).toHaveLength(4);
	});

	it('creates units and trays it has not seen, and lights by node', () => {
		const raw = mergeReport(
			{},
			{ ams: { ams: [{ id: '2', tray: [{ id: '3', tray_type: 'PLA' }] }] } }
		);
		mergeReport(raw, { lights_report: [{ node: 'chamber_light', mode: 'on' }] });
		mergeReport(raw, { lights_report: [{ node: 'work_light', mode: 'off' }] });
		const s = parse(x1c, raw);
		expect(s.ams[0].trays[0].global).toBe(11);
		expect(s.lights).toMatchObject({ chamber: 'on', work: 'off' });
	});

	it('replaces plain arrays: hms clears with [], stays when omitted', () => {
		const f = load('p1-delta-sequence');
		const raw = fresh(f);
		mergeReport(raw, { hms: [{ attr: 1, code: 2 }] });
		mergeReport(raw, { gcode_state: 'RUNNING' });
		expect(parse(f, raw).hms).toEqual([{ attr: 1, code: 2 }]);
		mergeReport(raw, { hms: [] });
		expect(parse(f, raw).hms).toEqual([]);
	});

	it('ignores command replies and prototype keys', () => {
		const f = load('p1s');
		const raw = fresh(f);
		mergeReport(raw, { command: 'ams_filament_setting', tray_type: 'TPU', ams_id: 0 });
		mergeReport(raw, JSON.parse('{"__proto__": {"polluted": true}, "gcode_state": "PAUSE"}'));
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(parse(f, raw).gcodeState).toBe('PAUSE');
		expect(parse(f, raw).ams[0].trays[0].type).toBe('PLA');
	});

	it('the delta sequence ends finished, with the new tray, humidity and no alert', () => {
		const f = load('p1-delta-sequence');
		const raw = fresh(f);
		const states: string[] = [];
		for (const d of f.deltas!) {
			mergeReport(raw, structuredClone(d));
			states.push(parse(f, raw).gcodeState);
		}
		expect([...new Set(states)]).toEqual(['IDLE', 'PREPARE', 'RUNNING', 'FINISH']);
		const s = parse(f, raw);
		expect(s.ams[0].trays[2]).toMatchObject({ type: 'PLA', color: '#f4d03f', global: 2 });
		expect(s.ams[0].humidityIndex).toBe(2);
		expect(s.hms).toEqual([]);
	});
});

describe('trays and nozzles', () => {
	it('numbers AMS HT units by their id and follows their activity', () => {
		const f = load('h2d-ext-spool');
		const s = parse(f, fresh(f));
		const ht = s.ams.filter((u) => u.model === 'AMS HT');
		expect(ht.map((u) => u.trays.map((t) => t.global))).toEqual([[128], [129]]);
		const raw = fresh(f);
		mergeReport(raw, { device: { extruder: { info: [{ id: 0, snow: (129 << 8) | 0 }] } } });
		const after = parse(f, raw);
		expect(after.activeTray).toBe(129);
		expect(after.ams.find((u) => u.id === 129)!.trays[0].active).toBe(true);
	});

	it('reads the active tray per nozzle from snow on the H2D and X2D', () => {
		const h2d = load('h2d');
		const s = parse(h2d, fresh(h2d));
		expect(s.nozzles.map((n) => n.activeTray)).toEqual([7, null]);
		const x2d = load('x2d');
		const x = parse(x2d, fresh(x2d));
		expect(x.activeNozzle).toBe(1);
		expect(x.nozzles.map((n) => [n.id, n.temp, n.target, n.activeTray])).toEqual([
			[0, 50, 0, null],
			[1, 250, 250, 1]
		]);
		expect([x.nozzle, x.nozzleTarget, x.activeTray]).toEqual([250, 250, 1]);
		// AMS 2 Pro (info 11002103) feeding the deputy nozzle.
		expect(x.ams[0]).toMatchObject({ model: 'AMS 2 Pro', nozzle: 1 });
	});

	it('knows the external spools (254/255) and their activity', () => {
		const h2d = load('h2d-ext-spool');
		const s = parse(h2d, fresh(h2d));
		expect(s.externalSpools.map((t) => [t.global, t.type, t.active])).toEqual([
			[EXT_MAIN, 'TPU', true],
			[EXT_DEPUTY, 'PLA', false]
		]);
		expect(s.activeTray).toBe(EXT_MAIN);
		const p1p = load('p1p-no-ams');
		expect(parse(p1p, fresh(p1p)).externalSpools[0]).toMatchObject({
			global: EXT_MAIN,
			type: 'PETG',
			active: true
		});
	});

	it('unpacks new-firmware temperatures (low word now, high word target)', () => {
		const x2d = load('x2d');
		const s = parse(x2d, fresh(x2d));
		expect([s.bed, s.bedTarget]).toEqual([70, 70]);
		const raw = mergeReport(fresh(x2d), {
			device: {
				bed: { info: { temp: (100 << 16) | 64 } },
				ctc: { info: { temp: (45 << 16) | 38 } }
			}
		});
		expect(parse(x2d, raw)).toMatchObject({
			bed: 64,
			bedTarget: 100,
			chamber: 38,
			chamberTarget: 45
		});
	});

	it('numbers the A2L AMS Lite 24–27', () => {
		const f = load('a2l');
		const s = parse(f, fresh(f));
		expect(s.ams[0]).toMatchObject({ id: 16, model: 'AMS Lite' });
		expect(s.ams[0].trays.map((t) => t.global)).toEqual([24, 25, 26, 27]);
	});

	it('maps legacy tray_now and snow the way Bambu Studio does', () => {
		expect(trayFromTrayNow('254')).toBe(EXT_MAIN);
		expect(trayFromTrayNow('255')).toBeNull();
		expect(trayFromTrayNow('6')).toBe(6);
		expect(trayFromTrayNow('129')).toBe(129);
		expect(trayFromSnow(0xffff)).toBeNull();
		expect(trayFromSnow(0x0103)).toBe(7);
		expect(trayFromSnow(0x8000)).toBe(128);
		expect(trayFromSnow(0xfe00)).toBe(EXT_DEPUTY);
		expect(trayFromSnow(0xffff - 0xff)).toBe(EXT_MAIN);
		expect(trayFromSnow(0x1002)).toBe(26);
		expect(amsSlotOf(7)).toEqual({ ams_id: 1, slot_id: 3 });
		expect(amsSlotOf(129)).toEqual({ ams_id: 129, slot_id: 0 });
		expect(amsSlotOf(EXT_DEPUTY)).toEqual({ ams_id: 254, slot_id: 0 });
		expect(amsSlotOf(25)).toEqual({ ams_id: 16, slot_id: 1 });
		expect(amsSlotOf(-1)).toEqual({ ams_id: 255, slot_id: 255 });
	});

	it('clamps and validates values from the network', () => {
		const f = load('p1s');
		const raw = mergeReport(fresh(f), {
			subtask_name: 'x'.repeat(500),
			mc_percent: 'lots',
			ams: {
				ams: [{ id: '0', humidity: '9', temp: '400', tray: [{ id: '0', tray_color: 'red' }] }]
			}
		});
		const s = parse(f, raw);
		expect(s.task).toHaveLength(200);
		expect(s.percent).toBeNull();
		expect(s.ams[0]).toMatchObject({ humidityIndex: null, temp: null });
		expect(s.ams[0].trays[0].color).toBeNull();
	});
});

describe('flags', () => {
	it('decodes 64-bit and longer flag strings with BigInt', () => {
		expect(flagValue('40029FD1B30F9CB7')).toBe(0x40029fd1b30f9cb7n);
		expect(hexFlag('40029FD1B30F9CB7', 62)).toBe(1);
		expect(hexFlag('40029FD1B30F9CB7', 39)).toBe(1);
		expect(hexFlag('1' + '0'.repeat(20), 80)).toBe(1);
		expect(firmwareSupport(undefined, '1' + '0'.repeat(19) + '20')).toMatchObject({
			remoteDrying: true,
			printWithEmmc: false
		});
		expect(hexFlag(undefined, 3)).toBeNull();
		expect(hexFlag('zz', 3)).toBeNull();
	});

	it('reads Developer Mode from fun bit 29', () => {
		// ha-bambulab const.py: 3EC1AFFF9CFF with Developer Mode off, 3EC18FFF9CFF with it on.
		expect(developerMode('3EC1AFFF9CFF')).toBe(false);
		expect(developerMode('3EC18FFF9CFF')).toBe(true);
		// MOCK-H2D.json and MOCK-X2D.json come from printers with it off; MOCK-H2DPRO.json with it on.
		expect(developerMode('1AFFF9CFF')).toBe(false);
		expect(developerMode('40029FD1B30F9CB7')).toBe(false);
		expect(developerMode('4023FF18FFF9CB3')).toBe(true);
		expect(developerMode(undefined)).toBeNull();
	});

	it('decodes firmware feature bits from the X2D mock', () => {
		expect(firmwareSupport('40029FD1B30F9CB7', 'B7B77')).toMatchObject({
			mqttBedTemp: true,
			mqttHoming: true,
			mqttAxis: true,
			partSkip: true,
			nozzleRack: false,
			remoteDrying: true
		});
	});
});

describe('model catalogue', () => {
	it('has every model with the verified hand-written columns', () => {
		expect(Object.keys(PRINTER_MODELS)).toEqual([...MODEL_CODES]);
		expect(PRINTER_MODELS.C12).toMatchObject({
			name: 'Bambu Lab P1S',
			short: 'P1S',
			series: 'P1',
			reports: 'delta',
			camera: 'jpeg6000',
			printUrl: 'sdcard',
			bedTempMax: 100
		});
		expect(PRINTER_MODELS['BL-P001']).toMatchObject({ reports: 'full', printUrl: 'sdcard' });
		expect(PRINTER_MODELS.N6).toMatchObject({ nozzles: 2, printUrl: 'ftp', chamberTempMax: 65 });
		expect(PRINTER_MODELS.N6.caps).toMatchObject({ dualNozzle: true, secondaryAuxFan: true });
		expect(PRINTER_MODELS.N1.caps.chamberFan).toBe(false);
	});

	it('gates capabilities by firmware', () => {
		expect(capabilitiesFor('C12', null).amsSwitchCommand).toBe(false);
		expect(capabilitiesFor('C12', '01.02.99.00').amsSwitchCommand).toBe(false);
		expect(capabilitiesFor('C12', '01.02.99.10').amsSwitchCommand).toBe(true);
		expect(capabilitiesFor('C12', '01.08.01.00').amsReadRfid).toBe(true);
		expect(capabilitiesFor('C12', '01.07.00.00').amsReadRfid).toBe(false);
		// X1Plus firmware counts as 01.08.02.00 (ha-bambulab supports_sw_version).
		expect(capabilitiesFor('BL-P001', '99.00.00.01').amsReadRfid).toBe(false);
		expect(compareFirmware('01.07.50.18', '01.07.50.2')).toBe(1);
	});

	it('detects models from SSDP, product names and older module heuristics', () => {
		expect(detectModel({ ssdpModel: 'N7' })).toBe('N7');
		expect(detectModel({ productName: 'Bambu Lab X1-Carbon' })).toBe('BL-P001');
		expect(detectModel({ productName: 'Bambu Lab H2C' })).toBe('O1C2');
		expect(detectModel({ ssdpModel: 'O1C', productName: 'Bambu Lab H2C' })).toBe('O1C');
		expect(detectModel({ productName: 'Something else' })).toBeNull();
		expect(sameModel('O1C', 'O1C2')).toBe(true);
		expect(sameModel('C12', 'N6')).toBe(false);
	});

	it('names stages in plain words', () => {
		expect(stageName(255)).toBe('Idle');
		expect(stageName(6)).toBe('Paused: filament ran out');
		expect(stageName(999)).toBe('Working');
	});
});

describe('simulator conformance', () => {
	// Which fixture each simulated model starts from (sim/states/*.json).
	const SIMULATED: [ModelCode, string][] = [
		['BL-P001', 'x1c-multi-ams'],
		['C11', 'p1p-no-ams'],
		['C12', 'p1s'],
		['N1', 'a1-mini'],
		['N2S', 'a1'],
		['N9', 'a2l'],
		['N7', 'p2s'],
		['N6', 'x2d'],
		['O1D', 'h2d'],
		['O1E', 'h2d-pro'],
		['O1S', 'h2s'],
		['O1C2', 'h2c']
	];
	/** Which parts of a snapshot are there at all, whatever their values. */
	const shape = (s: PrinterSnapshot) => {
		const set = (o: object) =>
			Object.entries(o)
				.filter(([, v]) => v !== null && v !== undefined)
				.map(([k]) => k)
				.sort();
		return {
			nozzles: s.nozzles.map((n) => set({ ...n, activeTray: null, temp: 0, target: 0 })),
			ams: s.ams.map((u) => [u.id, u.model, u.trays.map((t) => t.global)]),
			externalSpools: s.externalSpools.map((t) => t.global),
			fans: set(s.fans),
			lights: set(s.lights),
			camera: set({ ...s.camera, rtspUrl: null, lanLiveview: null }),
			chamberTarget: s.chamberTarget !== null,
			airductMode: s.airductMode !== null,
			doorOpen: s.doorOpen !== null,
			developerMode: s.developerMode !== null,
			firmwareSupport: Object.keys(s.firmwareSupport).sort(),
			firmware: s.firmware.version
		};
	};

	it.each(SIMULATED)('the simulated %s reports like the real one (%s)', async (model, fixture) => {
		const { createSimulator } = await import('./sim/core');
		const { BambuPrinter } = await import('./bambu');
		const sim = createSimulator({ model, speed: 1, failRate: 0, log: () => {} });
		const port = await sim.listen(0);
		const printer = new BambuPrinter({
			id: model,
			model,
			host: '127.0.0.1',
			port,
			serial: sim.serial,
			accessCode: sim.accessCode,
			useTls: false,
			simulated: true
		}).start();
		try {
			for (let i = 0; i < 250 && !(printer.snapshot && printer.versions.length); i++)
				await new Promise((r) => setTimeout(r, 20));
			const f = load(fixture);
			const expected = parse(f, fresh(f));
			expect(shape(printer.snapshot!)).toEqual(shape(expected));
			// Idle, with Developer Mode on, so the app may send it commands.
			expect(printer.snapshot!.gcodeState).toBe('IDLE');
			if (expected.developerMode !== null) expect(printer.snapshot!.developerMode).toBe(true);
		} finally {
			printer.stop();
			await sim.close();
		}
	});
});
