// The preview loader: waiting on a background task, errors in plain words, and not starting a stopped
// task over and over.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePreview, PREVIEW_FEATURES, type PreviewData } from '$lib/shared/slicer/preview';
import { loadPreview } from './load';

const preview: PreviewData = {
	header: {
		version: 1,
		plate: 1,
		source: 'gcode',
		segments: 1,
		bbox: [0, 0, 0, 1, 0, 0],
		features: [...PREVIEW_FEATURES],
		tools: [{ index: 0, color: '#FFFFFF', type: 'PLA' }],
		layers: [{ z: 0.2, height: 0.2, seconds: 1, first: 0, count: 1 }],
		totalSeconds: 1
	},
	seg: new Float32Array([0, 0, 0.2, 1, 0, 0.2]),
	attr: new Uint8Array([2, 0, 42, 20]),
	speed: new Uint16Array([100])
};

/** A fetch that gives these answers in turn. */
function answers(...list: Response[]) {
	const fetch = vi.fn(async () => list.shift()!);
	vi.stubGlobal('fetch', fetch);
	return fetch;
}
const pending = (taskId: string) => Response.json({ status: 'parsing', taskId }, { status: 202 });
const opts = () => ({
	jobId: 'j1',
	plate: 2,
	file: 'j1-abc.gcode.3mf',
	signal: new AbortController().signal
});

afterEach(() => vi.unstubAllGlobals());

describe('loadPreview', () => {
	it('asks again while the plate is read in the background, then decodes it', async () => {
		const fetch = answers(
			pending('t1'),
			pending('t1'),
			new Response(new Uint8Array(encodePreview(preview)))
		);
		const waiting: string[] = [];
		const data = await loadPreview(opts(), (id) => waiting.push(id), 1);
		expect(data.header.layers).toHaveLength(1);
		expect(waiting).toEqual(['t1', 't1']);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(fetch.mock.calls[0]).toEqual([
			'/api/jobs/j1/sliced/preview?plate=2&f=j1-abc.gcode.3mf',
			expect.anything()
		]);
	});

	it('stops when the task it waited on was stopped, rather than starting it again', async () => {
		answers(pending('t1'), pending('t2'));
		await expect(loadPreview(opts(), () => {}, 1)).rejects.toThrow(/stopped/);
	});

	it('gives the server’s error in its words', async () => {
		answers(Response.json({ error: 'The G-code in this file is damaged.' }, { status: 422 }));
		await expect(loadPreview(opts(), () => {}, 1)).rejects.toThrow('damaged');
	});

	it('stops waiting when the preview is closed', async () => {
		answers(pending('t1'));
		const abort = new AbortController();
		const run = loadPreview({ ...opts(), signal: abort.signal }, () => abort.abort(), 60_000);
		await expect(run).rejects.toThrow('Stopped');
	});
});
