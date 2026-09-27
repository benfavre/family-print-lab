// Previews through the running app: the module, the worker thread, the cache next to the sliced file,
// background tasks for large plates, the API route, and the sweep that removes caches with their file.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../testing/harness';
import { readZip, writeZip } from '../cad/mesh';
import { createGcodeParser, packPreview } from './parse';
import { previewInWorker } from './worker';
import { GET } from '../../../routes/api/jobs/[id]/sliced/preview/+server';
import { PREVIEW_FEATURES, TRAVEL_FEATURE, decodePreview } from '$lib/shared/slicer/preview';

const FIXTURE = path.join(__dirname, '__fixtures__', 'a1-mini-cube.gcode.3mf');
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');
let t: TestLab;

beforeAll(async () => {
	t = await startTestLab({
		modules: ['gcode-preview'],
		fleet: ['N1'],
		env: { GCODE_PREVIEW_LARGE_BYTES: '1000000' }
	});
	holder[key] = t.rt;
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

function newJob(file: Buffer, name = 'cube.gcode.3mf') {
	const { lab, printing } = t.rt;
	const profileId = lab.createProfile({ name: 'Ana', color: 'pink' });
	const projectId = lab.createProject({ profileId, title: 'Cube' });
	const jobId = lab.createJob({ projectId });
	printing.attach(jobId, file, name);
	return lab.getJob(jobId)!;
}

async function get(jobId: string, query = '') {
	const res = await GET({
		params: { id: jobId },
		url: new URL(`http://localhost/api/jobs/${jobId}/sliced/preview${query}`)
	} as unknown as RequestEvent);
	return res;
}

/** A sliced file whose plate is `layers` layers of back-and-forth lines (about 5 MB of G-code per 100). */
function bigSliced(layers: number) {
	const lines = [
		'; HEADER_BLOCK_START',
		'; total layer number: ' + layers,
		'; HEADER_BLOCK_END',
		'M83'
	];
	for (let l = 1; l <= layers; l++) {
		lines.push('; CHANGE_LAYER', `; Z_HEIGHT: ${(l * 0.2).toFixed(1)}`, '; LAYER_HEIGHT: 0.2');
		lines.push(`G1 Z${(l * 0.2).toFixed(1)} F600`, '; FEATURE: Sparse infill');
		for (let i = 0; i < 2000; i++)
			lines.push(`G1 X${i % 2 ? 200 : 20} Y${(20 + i * 0.09).toFixed(3)} E0.51234 F12000`);
	}
	const gcode = Buffer.from(lines.join('\n'));
	const info = `<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="3600"/><filament id="1" type="PLA" color="#FF0000" used_g="10"/></plate></config>`;
	return {
		size: gcode.length,
		file: writeZip([
			['Metadata/plate_1.gcode', gcode],
			['Metadata/slice_info.config', Buffer.from(info)]
		])
	};
}

describe('previewInWorker', () => {
	it('gives the same container as parsing in-process', async () => {
		const zip = readZip(fs.readFileSync(FIXTURE), (n) => (n.endsWith('.gcode') ? 'all' : false));
		const gcode = zip.get('Metadata/plate_1.gcode')!;
		const p = createGcodeParser({ plate: 1, features: PREVIEW_FEATURES });
		p.push(gcode);
		const expected = packPreview(p.finish(), TRAVEL_FEATURE);
		const progress: number[] = [];
		const stored = await previewInWorker(
			{ raw: gcode, method: 0, size: gcode.length },
			{ plate: 1, features: PREVIEW_FEATURES },
			{ onProgress: (f) => progress.push(f) }
		);
		expect(stored.bytes).toEqual(expected);
		expect(stored.layers).toBe(50);
		expect(progress.length).toBeGreaterThan(0);
	});

	it('rejects damaged data in plain words, and stops when asked', async () => {
		const opts = { plate: 1, features: PREVIEW_FEATURES };
		await expect(
			previewInWorker({ raw: new Uint8Array([1, 2, 3, 4, 5]), method: 8, size: 5 }, opts)
		).rejects.toThrow(/damaged/);
		const abort = new AbortController();
		const run = previewInWorker({ raw: new Uint8Array(10), method: 0, size: 10 }, opts, {
			signal: abort.signal
		});
		abort.abort();
		await expect(run).rejects.toThrow('Stopped');
	});
});

describe('GET /api/jobs/[id]/sliced/preview', () => {
	it('answers a small plate straight away, caches it next to the file, and sweeps it with the file', async () => {
		const job = newJob(fs.readFileSync(FIXTURE));
		const res = await get(job.id, `?plate=1&f=${job.sliced!.file}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toContain('immutable');
		const data = decodePreview(new Uint8Array(await res.arrayBuffer()));
		expect(data.header.layers).toHaveLength(50);
		const cache = path.join(t.rt.printing.dir, `${job.sliced!.file}.plate1.preview.bin`);
		expect(fs.existsSync(cache)).toBe(true);
		// Served from the cache the second time (even if the sliced file's G-code were gone).
		const again = await get(job.id);
		expect(again.headers.get('cache-control')).toBe('no-cache');
		expect(new Uint8Array(await again.arrayBuffer())).toEqual(
			new Uint8Array(fs.readFileSync(cache))
		);
		t.rt.printing.detach(job.id);
		expect(fs.existsSync(cache)).toBe(false);
	});

	it('takes the plate’s filament colours from the sliced file', async () => {
		const job = newJob(fs.readFileSync(FIXTURE));
		const data = decodePreview(new Uint8Array(await (await get(job.id)).arrayBuffer()));
		expect(data.header.tools).toEqual([{ index: 0, color: '#0078BF', type: 'PLA' }]);
	});

	it('answers 404 for a job without a file or a plate that is not there', async () => {
		const { lab } = t.rt;
		const profileId = lab.createProfile({ name: 'Bo', color: 'blue' });
		const projectId = lab.createProject({ profileId, title: 'Empty' });
		const bare = lab.createJob({ projectId });
		expect((await get(bare)).status).toBe(404);
		const job = newJob(fs.readFileSync(FIXTURE));
		const res = await get(job.id, '?plate=4');
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'That plate is not in the file.' });
	});

	it(
		'reads a 50 MB plate as a background task without blocking requests',
		{ timeout: 120_000 },
		async () => {
			const big = bigSliced(1000);
			expect(big.size).toBeGreaterThan(50_000_000);
			const job = newJob(big.file, 'big.gcode.3mf');
			// Measure how late a 10 ms timer fires while the plate is read.
			let worst = 0,
				last = performance.now();
			const timer = setInterval(() => {
				const now = performance.now();
				worst = Math.max(worst, now - last - 10);
				last = now;
			}, 10);
			try {
				const first = await get(job.id);
				expect(first.status).toBe(202);
				const { taskId } = await first.json();
				expect((await (await get(job.id)).json()).taskId).toBe(taskId); // the same task while it runs
				for (let i = 0; i < 600 && t.rt.tasks.get(taskId).status === 'running'; i++)
					await new Promise((r) => setTimeout(r, 100));
				expect(t.rt.tasks.get(taskId)).toMatchObject({ status: 'done', kind: 'gcode-preview' });
			} finally {
				clearInterval(timer);
			}
			expect(worst).toBeLessThan(250);
			const res = await get(job.id);
			expect(res.status).toBe(200);
			const data = decodePreview(new Uint8Array(await res.arrayBuffer()));
			expect(data.header.layers).toHaveLength(1000);
			expect(data.header.segments).toBe(1000 * 2001);
		}
	);
});
