// Golden slices (slicer/tests/golden/expected.json): run when PRINTLAB_SLICER_PATH points at an
// engine with a slicing core (upstream.sh test sets it). Each case slices a box through the same path
// jobs use (service.ts) and compares layers exactly, time and weight within the tolerance, and the
// header the printer reads. GOLDEN_UPDATE=1 GOLDEN_REASON='…' records the measured values instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRINTER_MODELS, type ModelCode } from '$lib/shared/printers/models';
import { readZip, writeStl } from '../cad/mesh';
import { readSliced } from '../printer/sliced';
import { StdioEngine } from './engine';
import { sliceModel } from './service';

const BIN = process.env.PRINTLAB_SLICER_PATH;
const FILE = path.resolve(import.meta.dirname, '../../../../../slicer/tests/golden/expected.json');
const LOCK = path.resolve(import.meta.dirname, '../../../../../slicer/upstream.lock');

interface Case {
	name: string;
	model: ModelCode;
	box: [number, number, number];
	layers: number;
	seconds: number | null;
	grams: number | null;
	nozzleDiameters: string | null;
}
interface Golden {
	about: string;
	tolerance: { seconds: number; grams: number };
	reasons: string[];
	cases: Case[];
}

function box([w, d, h]: [number, number, number]): Float32Array {
	const v = [
		[0, 0, 0],
		[w, 0, 0],
		[w, d, 0],
		[0, d, 0],
		[0, 0, h],
		[w, 0, h],
		[w, d, h],
		[0, d, h]
	];
	const f = [
		[0, 2, 1],
		[0, 3, 2],
		[4, 5, 6],
		[4, 6, 7],
		[0, 1, 5],
		[0, 5, 4],
		[1, 2, 6],
		[1, 6, 5],
		[2, 3, 7],
		[2, 7, 6],
		[3, 0, 4],
		[3, 4, 7]
	];
	return new Float32Array(f.flatMap((t) => t.flatMap((i) => v[i])));
}

const golden = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Golden;
const tag = fs.readFileSync(LOCK, 'utf8').match(/^tag=v?(.+)$/m)?.[1] ?? '';

let engine: StdioEngine | null = null;
let slicing = false;
const measured: Record<string, Partial<Case>> = {};

describe.runIf(!!BIN)('golden slices', () => {
	beforeAll(async () => {
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-golden-'));
		engine = await StdioEngine.open({ command: BIN!, workDir });
		slicing = engine.has('slice');
	});
	afterAll(async () => {
		// The tag before closing: a closed engine has no info.
		const upstreamTag = engine?.info.upstream.tag;
		await engine?.close();
		if (process.env.GOLDEN_UPDATE === '1' && Object.keys(measured).length) {
			const reason = process.env.GOLDEN_REASON;
			if (!reason) throw new Error('Set GOLDEN_REASON to say why the golden values change.');
			golden.cases = golden.cases.map((c) => ({ ...c, ...measured[c.name] }));
			golden.reasons.push(`${new Date().toISOString().slice(0, 10)} ${upstreamTag}: ${reason}`);
			fs.writeFileSync(FILE, `${JSON.stringify(golden, null, '\t')}\n`);
		}
	});

	it.for(golden.cases)('$name', { timeout: 300_000 }, async (c, { skip }) => {
		if (!slicing) skip(); // a protocol-only build cannot slice
		const r = await sliceModel({
			engine: engine!,
			stl: writeStl(box(c.box)),
			name: c.name,
			settings: {
				model: c.model,
				nozzle: '0.4',
				layerHeight: '0.20',
				material: 'PLA',
				supports: 'None',
				infill: 15,
				plate: 'Textured PEI'
			}
		});
		const file = readSliced(r.data);
		const info = readZip(r.data, (n) => (n === 'Metadata/slice_info.config' ? 'all' : false))
			.get('Metadata/slice_info.config')!
			.toString('utf8');
		const nozzles = info.match(/key="nozzle_diameters" value="([^"]*)"/)?.[1] ?? '';
		// Keep the engine's exported seconds, before the job UI rounds them to minutes. In
		// particular, never bless NaN/Infinity or the INT_MIN sentinel from a broken estimate.
		const seconds = Number(info.match(/key="prediction" value="([^"]*)"/)?.[1]);
		expect(Number.isFinite(seconds)).toBe(true);
		expect(seconds).toBeGreaterThan(0);
		expect(seconds).toBeLessThan(86_400);
		expect(Number.isFinite(r.grams)).toBe(true);
		expect(r.grams).toBeGreaterThan(0);

		expect(file.plates).toHaveLength(1);
		expect(file.plates[0].layers).toBe(c.layers);
		expect(file.plates[0].md5).toMatch(/^[0-9A-F]{32}$/);
		expect(file.printerModelId).toBe(PRINTER_MODELS[c.model].code);
		expect(file.slicer).toBe(`slicer ${tag}`);
		measured[c.name] = { seconds, grams: r.grams, nozzleDiameters: nozzles };
		if (process.env.GOLDEN_UPDATE === '1') return;
		if (c.nozzleDiameters !== null) expect(nozzles).toBe(c.nozzleDiameters);
		if (c.seconds !== null)
			expect(Math.abs(seconds - c.seconds)).toBeLessThanOrEqual(
				Math.max(60, c.seconds * golden.tolerance.seconds)
			);
		if (c.grams !== null)
			expect(Math.abs(r.grams - c.grams)).toBeLessThanOrEqual(
				Math.max(0.1, c.grams * golden.tolerance.grams)
			);
	});
});
