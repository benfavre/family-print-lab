// The slicer-calibration module in a test lab (fixture vendor profiles, a simulated A1 mini and H2D, a fake
// Print Lab Slicer): a run slices into a queued job on the Calibration project, the picked value goes
// into a user filament preset and the spool, the queue takes the job, the API routes answer, and the
// printer's own calibration and K profiles work against the simulator.
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../../testing/harness';
import { FIXTURE } from '../../profiles/__fixtures__/helpers';
import { fakeSliced } from '../../printer/sliced';
import { EngineError, type SlicerEngine } from '../../slicer/engine-types';
import { ERROR, type EngineInfo, type EngineMethods } from '$lib/shared/slicer/protocol';
import { CALIB_KINDS, type CalibRun } from '$lib/shared/slicer-calibration';
import type { Calibration } from './service';
import { calibrationRuns } from '../../db/schema';
import { PrinterRefused } from '../../printer/bambu';
import * as overviewRoute from '../../../../routes/api/calibration/+server';
import * as runsRoute from '../../../../routes/api/calibration/runs/+server';
import * as resultRoute from '../../../../routes/api/calibration/runs/[id]/result/+server';
import * as kRoute from '../../../../routes/api/printers/[id]/calibration/k-profiles/+server';

let t: TestLab;
let c: Calibration;
let printerId: string;
/** A simulated H2D: it reports the calibration feature bits. */
let dualId: string;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');
const calls: { method: string; params: unknown }[] = [];

/** A Print Lab Slicer that makes every test and exports a small valid .gcode.3mf. */
function fakeEngine(o: { engine?: EngineInfo['engine']; fail?: string } = {}): SlicerEngine {
	const info: EngineInfo = {
		engine: o.engine ?? 'printlab-slicer',
		version: '0.1.0',
		protocol: { major: 1, minor: 0 },
		upstream: { name: 'BambuStudio', tag: 'v02.08.02.61', commit: null },
		patchQueue: null,
		capabilities: ['slice', 'export.gcode3mf', ...CALIB_KINDS.map((k) => `calib.${k}` as const)],
		profiles: null
	};
	return {
		info,
		has: (cap) => info.capabilities.includes(cap),
		async call<M extends keyof EngineMethods>(method: M, params: EngineMethods[M]['params']) {
			calls.push({ method, params });
			if (o.fail === method) throw new EngineError(ERROR.SLICE_FAILED, 'The slicer gave up.');
			const answers: Partial<Record<keyof EngineMethods, () => unknown>> = {
				'calib.generate': () => ({
					projectId: 'p1',
					project: {},
					title: 'Flow rate test, pass 1',
					steps: [
						{ value: 0.931, label: 'flowrate_m5' },
						{ value: 0.98, label: 'flowrate_0' }
					],
					baseFlowRatio: 0.98
				}),
				slice: () => ({
					plate: 1,
					seconds: 1800,
					layers: 7,
					filaments: [{ index: 1, grams: 12.3, meters: 4 }],
					objects: [],
					warnings: []
				}),
				'export.gcode3mf': () => {
					const p = params as EngineMethods['export.gcode3mf']['params'];
					fs.writeFileSync(p.path, fakeSliced({ minutes: 30, grams: 12.3, printerModelId: 'N1' }));
					return { path: p.path, plates: [] };
				},
				'project.close': () => ({ ok: true })
			};
			return answers[method]!() as EngineMethods[M]['result'];
		},
		close: async () => {}
	};
}

/** Tests swap in a fake engine (the module otherwise opens the installed one). */
const useEngine = (engine: SlicerEngine | null) =>
	((c as unknown as { d: { openSlicer: () => Promise<SlicerEngine | null> } }).d.openSlicer =
		async () => engine);

async function settled(id: string): Promise<CalibRun> {
	for (let i = 0; i < 200; i++) {
		const run = c.get(id);
		if (run.status !== 'slicing') return run;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error('The run did not finish.');
}

type Handler = (e: RequestEvent) => Promise<Response>;
async function call(
	handler: unknown,
	o: { params?: Record<string, string>; method?: string; body?: unknown; url?: string } = {}
) {
	const request = new Request(new URL(o.url ?? '/api/x', 'http://localhost'), {
		method: o.method ?? 'GET',
		headers: o.body !== undefined ? { 'content-type': 'application/json' } : {},
		body: o.body !== undefined ? JSON.stringify(o.body) : undefined
	});
	const res = await (handler as Handler)({
		request,
		params: o.params ?? {},
		url: new URL(request.url)
	} as unknown as RequestEvent);
	return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
	t = await startTestLab({
		modules: ['slicer-profiles', 'queue', 'slicer-calibration'],
		fleet: ['N1', 'O1D', 'BL-P001'],
		env: { PRINTLAB_PROFILES_DIR: FIXTURE }
	});
	holder[key] = t.rt;
	c = t.rt.module('slicer-calibration')!;
	printerId = t.printer('N1').info.id;
	dualId = t.printer('O1D').info.id;
	t.rt.lab.createProfile({ name: 'Sam', color: 'blue' });
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

describe('calibration runs', () => {
	it('says why tests are off without Print Lab Slicer', async () => {
		useEngine(null);
		expect(c.availability(null).every((a) => !a.available && /No slicer/.test(a.reason!))).toBe(
			true
		);
		const cli = fakeEngine({ engine: 'bambu-studio-cli' });
		expect(c.availability(cli)[0].reason).toMatch(/Needs Print Lab Slicer/);
		await expect(c.create({ kind: 'flow_rate', printerId })).rejects.toThrow(/No slicer/);
	});

	it('slices a test into a queued job and saves the picked value into a preset and the spool', async () => {
		useEngine(fakeEngine());
		const spoolId = t.rt.lab.createSpool({
			material: 'PLA',
			colorHex: '#ff8800',
			totalGrams: 1000,
			remainingGrams: 800
		});
		calls.length = 0;
		const run = await c.create({ kind: 'flow_rate', printerId, spoolId, params: { pass: 1 } });
		expect(run.status).toBe('slicing');
		const ready = await settled(run.id);
		expect(ready.status).toBe('ready');
		expect(ready.steps).toHaveLength(2);
		expect(ready.baseFlowRatio).toBe(0.98);

		// The engine was asked for the printer's presets with the spool's colour.
		const gen = calls.find((x) => x.method === 'calib.generate')!
			.params as EngineMethods['calib.generate']['params'];
		expect(gen.kind).toBe('flow_rate');
		expect(gen.selection.printer.name).toBe('Bambu Lab A1 mini 0.4 nozzle');
		expect(gen.selection.filaments[0].name).toBe('Bambu PLA Basic @BBL A1M');
		expect(gen.presets.full.filament_colour).toEqual(['#FF8800']);
		expect(calls.map((x) => x.method)).toEqual([
			'calib.generate',
			'slice',
			'export.gcode3mf',
			'project.close'
		]);

		// A queued job on the Calibration project, with the sliced file attached.
		const job = t.rt.lab.getJob(ready.jobId!)!;
		expect(job.status).toBe('Queued');
		expect(job.printerId).toBe(printerId);
		expect(job.sliced?.source).toBe('app');
		expect(t.rt.lab.projectTitle(job.projectId)).toBe('Calibration');
		expect((await c.overview()).projectId).toBe(job.projectId);

		// Into the queue.
		c.enqueue(run.id, {});
		expect(
			t.rt
				.module('queue')!
				.list()
				.items.some((i) => i.jobId === job.id)
		).toBe(true);

		// The winning block: a user preset made from the system one, and the spool slices with it.
		const done = c.setResult(run.id, { value: 0.931, label: 'flowrate_m5' });
		expect(done.status).toBe('done');
		expect(done.result).toMatchObject({ value: 0.931, spoolUpdated: true });
		const sp = t.rt.module('slicer-profiles')!;
		const preset = sp.lab.store.byName('filament', 'Bambu PLA Basic @BBL A1M - calibrated')!;
		expect(preset.inherits).toBe('Bambu PLA Basic @BBL A1M');
		expect(preset.config.filament_flow_ratio).toEqual(['0.931']);
		expect(sp.lab.spoolPreset(spoolId)).toMatchObject({ source: 'user', userPresetId: preset.id });

		// A second test on the same spool updates that preset (pressure advance this time).
		const pa = await settled((await c.create({ kind: 'pa_pattern', printerId, spoolId })).id);
		const gen2 = calls.filter((x) => x.method === 'calib.generate').at(-1)!
			.params as EngineMethods['calib.generate']['params'];
		expect(gen2.selection.filaments[0]).toMatchObject({ source: 'user', userPresetId: preset.id });
		expect(gen2.params).toEqual({ start: 0, end: 0.08, step: 0.005 });
		c.setResult(pa.id, { value: 0.025 });
		const again = sp.lab.store.get(preset.id)!;
		expect(again.config).toMatchObject({
			filament_flow_ratio: ['0.931'],
			pressure_advance: ['0.025'],
			enable_pressure_advance: ['1']
		});
	});

	it('refuses bad ranges and records engine failures', async () => {
		useEngine(fakeEngine({ fail: 'slice' }));
		await expect(
			c.create({ kind: 'temp_tower', printerId, params: { start: 200, end: 200, step: 5 } })
		).rejects.toThrow(/5 °C/);
		const run = await settled((await c.create({ kind: 'retraction', printerId })).id);
		expect(run.status).toBe('failed');
		expect(run.error).toBe('The slicer gave up.');
		expect(() => c.setResult(run.id, { value: 1 })).toThrow(/Slice and print/);
		c.remove(run.id);
		expect(() => c.get(run.id)).toThrow(/no longer exists/);
	});

	it('stops slicing when a run is removed, and fails runs left slicing by a restart', async () => {
		// An engine that never finishes calib.generate until it is stopped.
		const slow = fakeEngine();
		slow.call = ((_method: string, _params: unknown, o?: { signal?: AbortSignal }) =>
			new Promise((_resolve, reject) =>
				o?.signal?.addEventListener('abort', () =>
					reject(new EngineError(ERROR.CANCELLED, 'Stopped.'))
				)
			)) as SlicerEngine['call'];
		useEngine(slow);
		const jobs = t.rt.lab.snapshot().jobs.length;
		const run = await c.create({ kind: 'pa_tower', printerId });
		c.remove(run.id);
		await new Promise((r) => setTimeout(r, 20));
		expect(t.rt.tasks.get(run.taskId!).status).toBe('cancelled');
		expect(t.rt.lab.snapshot().jobs.length).toBe(jobs);

		t.rt.db
			.insert(calibrationRuns)
			.values({ id: 'stuck', kind: 'vfa', printerId, params: {} })
			.run();
		c.recover();
		expect(c.get('stuck')).toMatchObject({
			status: 'failed',
			error: expect.stringMatching(/restarted/)
		});
		c.remove('stuck');
	});

	it('answers on the API', async () => {
		useEngine(fakeEngine());
		const overview = await call(overviewRoute.GET);
		expect(overview.status).toBe(200);
		expect(overview.body.tests).toHaveLength(CALIB_KINDS.length);
		expect(overview.body.queue).toBe(true);
		const created = await call(runsRoute.POST, {
			method: 'POST',
			body: { kind: 'vfa', printerId, params: { start: 40, end: 120, step: 10 } }
		});
		expect(created.status).toBe(200);
		await settled(created.body.id);
		const result = await call(resultRoute.POST, {
			method: 'POST',
			params: { id: created.body.id },
			body: { value: 90, label: '90' }
		});
		// VFA is advice only: nothing to save.
		expect(result.body.result).toMatchObject({ value: 90, preset: null, spoolUpdated: false });
		const bad = await call(runsRoute.POST, { method: 'POST', body: { kind: 'warp', printerId } });
		expect(bad.status).toBe(400);
	});
});

describe('the printer’s own calibration (simulated H2D)', () => {
	it('lists, saves, picks and deletes K profiles', async () => {
		const info = c.info(dualId);
		expect(info.pa).toBeNull();
		expect(info.nozzleDiameter).toBe(0.4);
		const first = await c.kProfiles(dualId, {});
		expect(first).toEqual([
			expect.objectContaining({ caliIdx: 1, filamentId: 'GFA00', kValue: 0.02 })
		]);
		const saved = await c.saveKProfile(dualId, {
			name: 'PLA tower',
			kValue: 0.026,
			filamentId: 'GFA00'
		});
		expect(saved.map((k) => k.name)).toEqual(['Bambu PLA Basic', 'PLA tower']);
		expect(await c.selectKProfile(dualId, { tray: 0, caliIdx: 2, filamentId: 'GFA00' })).toEqual({
			ok: true
		});
		const left = await c.deleteKProfile(dualId, { caliIdx: 2, filamentId: 'GFA00' });
		expect(left).toHaveLength(1);
		const viaRoute = await call(kRoute.GET, {
			params: { id: dualId },
			url: '/api/x?filamentId=GFA00'
		});
		expect(viaRoute.body).toHaveLength(1);
	});

	it('knows which nozzle each tray feeds', () => {
		const info = c.info(dualId);
		// The simulated H2D: two standard 0.4 nozzles ("HS01"); AMS 0 feeds the left one (info 0x2103),
		// AMS 1 the right (0x2003). Its external spools are empty, so they are not listed.
		expect(info.nozzles).toEqual([
			{ id: 0, diameter: 0.4, volume: 'standard' },
			{ id: 1, diameter: 0.4, volume: 'standard' }
		]);
		const byTray = new Map(info.trays.map((x) => [x.global, x.extruderId]));
		expect([0, 1, 2, 3].map((g) => byTray.get(g))).toEqual([1, 1, 1, 1]);
		expect([4, 5, 6, 7].map((g) => byTray.get(g))).toEqual([0, 0, 0, 0]);
	});

	it('saves a result for the tray’s own extruder, with its n_coef', async () => {
		const tray = c.info(dualId).trays.find((x) => x.filamentId && x.extruderId === 1)!;
		const list = await c.saveKProfile(dualId, {
			name: 'Left auto',
			kValue: 0.03,
			filamentId: tray.filamentId,
			tray: tray.global,
			nCoef: 1.2
		});
		const saved = list.find((k) => k.name === 'Left auto')!;
		expect(saved).toMatchObject({ extruderId: 1, nCoef: 1.2, nozzleId: 'HS00-0.4' });
		await c.deleteKProfile(dualId, {
			caliIdx: saved.caliIdx,
			filamentId: saved.filamentId,
			extruderId: 1
		});
	});

	it('puts the printer’s refusals in plain words', async () => {
		const p = t.rt.printers.require(dualId);
		const send = p.send;
		p.send = async () => {
			throw new PrinterRefused(409, 'nozzle_diameter is not matched');
		};
		try {
			await expect(c.kProfiles(dualId, {})).rejects.toThrow(/does not match/);
		} finally {
			p.send = send;
		}
	});

	it('runs flow dynamics calibration and reads the results; flow rate is off on the H2D', async () => {
		const tray = c.info(dualId).trays.find((x) => x.filamentId && x.extruderId === 1);
		expect(tray).toBeDefined();
		await c.startOnPrinter(dualId, { kind: 'pa', trays: [tray!.global] });
		const pa = await c.resultsOnPrinter(dualId, { kind: 'pa' });
		expect('pa' in pa && pa.pa[0]).toMatchObject({
			kValue: 0.024,
			trayId: tray!.global,
			extruderId: 1
		});
		await expect(c.startOnPrinter(dualId, { kind: 'pa', trays: [99] })).rejects.toThrow(/empty/);
		// Bambu Studio turns flow rate calibration off for the H2 series, whatever the printer says.
		expect(c.info(dualId).flow).toMatch(/does not do flow rate/);
		await expect(c.startOnPrinter(dualId, { kind: 'flow', trays: [tray!.global] })).rejects.toThrow(
			/flow rate/
		);
	});

	it('runs flow rate calibration on an X1 and reads the result', async () => {
		const x1 = t.printer('BL-P001').info.id;
		const tray = c.info(x1).trays.find((x) => x.filamentId);
		expect(tray).toBeDefined();
		await c.startOnPrinter(x1, { kind: 'flow', trays: [tray!.global] });
		const flow = await c.resultsOnPrinter(x1, { kind: 'flow' });
		expect('flow' in flow && flow.flow[0].flowRatio).toBeGreaterThan(0.9);
	});
});
