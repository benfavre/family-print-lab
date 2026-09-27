// Golden calibration slices: run when PRINTLAB_SLICER_PATH points at an engine with a slicing core
// (like slicer/golden.test.ts). Each test is generated for real presets, sliced and exported, and its
// G-code must carry the right parameter steps: the pressure advance values, temperatures, retraction
// lengths and speeds upstream writes at each layer change, and each flow block's extrusion.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRINTER_MODELS } from '$lib/shared/printers/models';
import { CALIB_KINDS, calibDefaults, type CalibKind } from '$lib/shared/slicer-calibration';
import type { PresetSelection } from '$lib/shared/slicer/project';
import { readZip } from '../../cad/mesh';
import { readSliced } from '../../printer/sliced';
import { StdioEngine } from '../../slicer/engine';
import {
	flowByObject,
	layerTemperatures,
	paOverrides,
	retractionLengths,
	speedsByHeight
} from './gcode-checks';

const BIN = process.env.PRINTLAB_SLICER_PATH;

const system = <K extends 'printer' | 'process' | 'filament'>(kind: K, name: string) => ({
	kind,
	name,
	source: 'system' as const
});
const X1C: PresetSelection = {
	printer: system('printer', 'Bambu Lab X1 Carbon 0.4 nozzle'),
	process: system('process', '0.20mm Standard @BBL X1C'),
	filaments: [system('filament', 'Bambu PLA Basic @BBL X1C')]
};
const A1M: PresetSelection = {
	printer: system('printer', 'Bambu Lab A1 mini 0.4 nozzle'),
	process: system('process', '0.20mm Standard @BBL A1M'),
	filaments: [system('filament', 'Bambu PETG HF @BBL A1M')]
};

const close = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

let engine: StdioEngine | null = null;
let slicing = false;
let workDir = '';

async function run(kind: CalibKind, selection: PresetSelection, params = calibDefaults(kind)) {
	const presets = await engine!.call('profiles.resolve', { selection });
	const g = await engine!.call(
		'calib.generate',
		{ kind, params, selection, presets, bedType: 'Textured PEI Plate' },
		{ timeoutMs: 600_000 }
	);
	try {
		const stats = await engine!.call(
			'slice',
			{ projectId: g.projectId, plate: 1 },
			{ timeoutMs: 900_000 }
		);
		const out = path.join(workDir, `${kind}-${g.projectId}.gcode.3mf`);
		await engine!.call('export.gcode3mf', {
			projectId: g.projectId,
			plates: [1],
			path: out,
			thumbnails: 'engine'
		});
		const data = fs.readFileSync(out);
		const gcode = [...readZip(data, (n) => (n.endsWith('.gcode') ? 'all' : false)).values()][0];
		return { generated: g, stats, file: readSliced(data), gcode: gcode.toString('utf8') };
	} finally {
		await engine!.call('project.close', { projectId: g.projectId });
	}
}

describe.runIf(!!BIN)('golden calibration tests', () => {
	beforeAll(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-calib-golden-'));
		engine = await StdioEngine.open({ command: BIN!, workDir });
		slicing = engine.has('slice');
	});
	afterAll(async () => {
		await engine?.close();
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it('reports every test as a capability', ({ skip }) => {
		if (!slicing) skip();
		for (const kind of CALIB_KINDS) expect(engine!.has(`calib.${kind}`)).toBe(true);
	});

	it('flow rate: each block extrudes by its flow ratio', { timeout: 300_000 }, async ({ skip }) => {
		if (!slicing) skip();
		const r = await run('flow_rate', X1C, { pass: 1 });
		expect(r.generated.project.objects).toHaveLength(9);
		expect(r.stats.layers).toBe(7);
		const base = r.generated.baseFlowRatio!;
		expect(base).toBeGreaterThan(0);
		// Outer walls are the same shape on every block: extrusion per mm ∝ the block's flow ratio.
		const flows = [...flowByObject(r.gcode, 'Outer wall').values()].sort((a, b) => a - b);
		const expected = r.generated.steps.map((s) => s.value / base);
		expect(flows).toHaveLength(9);
		const mid = flows[4] / expected[4];
		flows.forEach((f, i) => expect(Math.abs(f / mid - expected[i])).toBeLessThan(0.01));
		expect(expected[0]).toBeCloseTo(0.8, 6);
		expect(expected[8]).toBeCloseTo(1.2, 6);
	});

	it("flow rate, YOLO: OrcaSlicer's linear blocks", { timeout: 300_000 }, async ({ skip }) => {
		if (!slicing) skip();
		const r = await run('flow_rate', X1C, { pass: 1, linear: true });
		const base = r.generated.baseFlowRatio!;
		expect(r.generated.steps).toHaveLength(11);
		expect(r.generated.steps[0].value).toBeCloseTo(base - 0.05, 6);
		expect(r.generated.steps[10].value).toBeCloseTo(base + 0.05, 6);
		const flows = [...flowByObject(r.gcode, 'Outer wall').values()].sort((a, b) => a - b);
		const expected = r.generated.steps.map((s) => s.value / base);
		const mid = flows[5] / expected[5];
		flows.forEach((f, i) => expect(Math.abs(f / mid - expected[i])).toBeLessThan(0.01));
	});

	for (const kind of ['pa_line', 'pa_pattern', 'pa_tower'] as const)
		it(`${kind}: every pressure advance value is set`, { timeout: 300_000 }, async ({ skip }) => {
			if (!slicing) skip();
			const r = await run(kind, X1C);
			const set = paOverrides(r.gcode);
			const steps = r.generated.steps.map((s) => s.value);
			expect(steps.length).toBeGreaterThan(10);
			for (const v of steps) expect(set.some((k) => close(k, v, 1e-4))).toBe(true);
			// Nothing outside the range (the tower's last layer sits on the cut, one step over).
			const top = steps[steps.length - 1] + (kind === 'pa_tower' ? 0.0021 : 1e-4);
			expect(set.every((k) => k >= 0 && k <= top)).toBe(true);
			if (kind === 'pa_tower') {
				// Rising one step per millimetre, in order.
				const rising = set.filter((k, i) => i === 0 || k !== set[i - 1]);
				expect(rising.slice(1).every((k, i) => k > rising[i])).toBe(true);
			}
			expect(r.file.printerModelId).toBe(PRINTER_MODELS['BL-P001'].code);
		});

	it('temperature tower: 5 °C cooler every 10 mm', { timeout: 300_000 }, async ({ skip }) => {
		if (!slicing) skip();
		const r = await run('temp_tower', X1C, { start: 230, end: 190, step: 5 });
		expect(layerTemperatures(r.gcode)).toEqual([230, 225, 220, 215, 210, 205, 200, 195, 190]);
		expect(r.stats.layers).toBe(450);
	});

	it('retraction: a step longer every millimetre', { timeout: 300_000 }, async ({ skip }) => {
		if (!slicing) skip();
		const r = await run('retraction', X1C, { start: 0, end: 2, step: 0.1 });
		const lengths = retractionLengths(r.gcode);
		for (const s of r.generated.steps)
			expect(lengths.some((l) => close(l, s.value, 1e-6))).toBe(true);
		expect(Math.max(...lengths)).toBeLessThanOrEqual(2 + 1e-6);
	});

	it('VFA: a speed step every 5 mm', { timeout: 300_000 }, async ({ skip }) => {
		if (!slicing) skip();
		const r = await run('vfa', X1C, { start: 40, end: 200, step: 10 });
		const speeds = speedsByHeight(r.gcode);
		for (const s of r.generated.steps)
			for (let z = Math.ceil(s.zMin!) + 1; z < s.zMax! - 1; z++)
				expect(speeds.get(z)).toBe(s.value);
	});

	it('max volumetric speed: faster with height', { timeout: 600_000 }, async ({ skip }) => {
		if (!slicing) skip();
		const r = await run('max_volumetric', X1C, { start: 5, end: 20, step: 0.5 });
		const speeds = speedsByHeight(r.gcode);
		// GCode.cpp: start + z × step, in mm/s after dividing by the wall's cross-section × flow ratio;
		// so speed(z) / speed(z0) = (start + z·step) / (start + z0·step).
		const z0 = 5;
		for (const z of [10, 15, 20, 25]) {
			const ratio = speeds.get(z)! / speeds.get(z0)!;
			const expected = (5 + (z + 0.9) * 0.5) / (5 + (z0 + 0.9) * 0.5);
			expect(Math.abs(ratio - expected)).toBeLessThan(0.03);
		}
	});

	it(
		'works for other printers and filaments too (A1 mini, PETG)',
		{ timeout: 300_000 },
		async ({ skip }) => {
			if (!slicing) skip();
			const r = await run('pa_pattern', A1M);
			const set = paOverrides(r.gcode);
			for (const s of r.generated.steps)
				expect(set.some((k) => close(k, s.value, 1e-4))).toBe(true);
			expect(r.file.printerModelId).toBe(PRINTER_MODELS.N1.code);
			const temps = await run('temp_tower', A1M, calibDefaults('temp_tower', { material: 'PETG' }));
			expect(layerTemperatures(temps.gcode)).toEqual([250, 245, 240, 235, 230]);
		}
	);
});
