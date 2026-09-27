// Runs the G-code parser in a worker thread, so a 50 MB plate never blocks web requests. The worker is
// built from the parser's own source text (like the OpenSCAD worker in cad/openscad.ts): no separate
// file to bundle, and the same code the tests run in-process. The plate's stored (deflated) bytes go
// in; the worker inflates them as a stream, parses as it goes and hands back the finished container.
import { Worker } from 'node:worker_threads';
import { createGcodeParser, packPreview, type ParseOptions } from './parse';

const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const zlib = require('node:zlib');
${createGcodeParser.toString()}
${packPreview.toString()}
const { raw, method, size, opts, travel } = workerData;
const parser = createGcodeParser(opts);
let seen = 0, told = 0;
const feed = (chunk) => {
	parser.push(chunk);
	seen += chunk.length;
	if (size > 0 && seen / size >= told + 0.05) {
		told = seen / size;
		parentPort.postMessage({ progress: Math.min(1, told) });
	}
};
const done = () => {
	const data = parser.finish();
	const out = packPreview(data, travel);
	parentPort.postMessage({ out, segments: data.header.segments, layers: data.header.layers.length }, [out.buffer]);
};
if (method === 0) {
	for (let i = 0; i < raw.length; i += 1 << 22) feed(raw.subarray(i, i + (1 << 22)));
	done();
} else {
	const inflate = zlib.createInflateRaw();
	inflate.on('data', feed);
	inflate.on('end', done);
	inflate.on('error', (e) => parentPort.postMessage({ error: 'The G-code in this file is damaged (' + e.message + ').' }));
	inflate.end(raw);
}
`;

export interface PlateEntry {
	/** The zip entry's stored bytes. */
	raw: Uint8Array;
	/** 0 stored, 8 deflated. */
	method: number;
	/** Inflated size (for progress). */
	size: number;
}

export interface WorkerResult {
	bytes: Uint8Array;
	segments: number;
	layers: number;
}

/** Parses one plate's G-code in a worker thread; rejects with a plain-words error. */
export function previewInWorker(
	entry: PlateEntry,
	opts: ParseOptions,
	o: { signal?: AbortSignal; onProgress?: (fraction: number) => void; timeoutMs?: number } = {}
): Promise<WorkerResult> {
	if (entry.method !== 0 && entry.method !== 8)
		return Promise.reject(
			new Error('The G-code in this file is packed in a way this app cannot read.')
		);
	const raw = new Uint8Array(entry.raw); // its own buffer, handed over rather than copied again
	return new Promise((resolve, reject) => {
		const worker = new Worker(SOURCE, {
			eval: true,
			workerData: {
				raw,
				method: entry.method,
				size: entry.size,
				opts: { ...opts, features: [...opts.features] },
				travel: opts.features.indexOf('Travel')
			},
			transferList: [raw.buffer]
		});
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			o.signal?.removeEventListener('abort', onAbort);
			void worker.terminate();
			fn();
		};
		const onAbort = () => finish(() => reject(new Error('Stopped')));
		o.signal?.addEventListener('abort', onAbort);
		const timer = setTimeout(
			() => finish(() => reject(new Error('Reading the toolpaths took too long and was stopped.'))),
			o.timeoutMs ?? 10 * 60_000
		);
		worker.on('message', (m) => {
			if (typeof m?.progress === 'number') o.onProgress?.(m.progress);
			else if (m?.error) finish(() => reject(new Error(m.error)));
			else if (m?.out)
				finish(() => resolve({ bytes: m.out, segments: m.segments, layers: m.layers }));
		});
		worker.on('error', (e) =>
			finish(() => reject(new Error(`Could not read the toolpaths: ${e.message}`)))
		);
		worker.on('exit', () =>
			finish(() => reject(new Error('Could not read the toolpaths (the worker stopped).')))
		);
	});
}
