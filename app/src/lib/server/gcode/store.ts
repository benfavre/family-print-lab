// Toolpath previews of attached sliced files: made on first request in a worker thread, then kept next
// to the sliced file as <file>.plate<N>.preview.bin (PrintFiles.sweep removes them with it, as it does
// every file that starts with the sliced file's name). Small plates are answered straight away; large
// ones become a background task and the caller is told to come back.
import fs from 'node:fs';
import { zipEntries } from '../cad/mesh';
import { AppError } from '../validation';
import type { PrintFiles } from '../printing';
import type { TaskCenter } from '../tasks';
import { previewInWorker, type PlateEntry, type WorkerResult } from './worker';
import { PREVIEW_FEATURES } from '$lib/shared/slicer/preview';
import type { Job } from '$lib/shared/domain';

/** Stored G-code above this many bytes is parsed as a background task. */
export const LARGE_GCODE_BYTES = 8 * 1000 * 1000;

export type PreviewAnswer = { bytes: Buffer } | { taskId: string };

export class PreviewStore {
	/** Previews being made, by cache path. */
	private making = new Map<string, { done: Promise<Buffer>; taskId: string | null }>();
	/** Plates that could not be read, by cache path: asking again gives the same answer, not a new try. */
	private failed = new Map<string, string>();
	/** One worker at a time: this machine may be small, and a queue keeps memory predictable. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private printing: PrintFiles,
		private tasks: TaskCenter,
		private opts: { largeBytes?: number; budget?: number } = {}
	) {}

	cachePath(file: string, plate: number) {
		return `${this.printing.file(file)}.plate${plate}.preview.bin`;
	}

	/** The job's plate preview: the bytes, or the task that is making them. */
	async get(job: Job, plate: number): Promise<PreviewAnswer> {
		const sliced = job.sliced;
		if (!sliced) throw new AppError(404, 'This job has no sliced file.');
		const info = sliced.plates.find((p) => p.index === plate);
		if (!info) throw new AppError(404, 'That plate is not in the file.');
		const cache = this.cachePath(sliced.file, plate);
		const cached = await fs.promises.readFile(cache).catch(() => null);
		if (cached) return { bytes: cached };
		const failure = this.failed.get(cache);
		if (failure) throw new AppError(422, failure);
		const running = this.making.get(cache);
		if (running) return running.taskId ? { taskId: running.taskId } : { bytes: await running.done };

		const source = this.printing.file(sliced.file);
		const data = await fs.promises.readFile(source).catch(() => null);
		if (!data) throw new AppError(404, 'The sliced file is missing. Attach it again.');
		const found = zipEntries(data).find((e) => e.name === `Metadata/plate_${plate}.gcode`);
		if (!found) throw new AppError(404, 'That plate has no G-code in the file.');
		const entry: PlateEntry = { raw: found.raw, method: found.method, size: found.size };
		const opts = {
			plate,
			features: PREVIEW_FEATURES,
			filaments: info.filaments
				.filter((f) => f.id >= 1)
				.map((f) => ({ index: f.id - 1, color: f.color, type: f.type })),
			budget: this.opts.budget
		};
		const make = (ctx?: { signal: AbortSignal; stage(text: string): void }) =>
			this.enqueue(async () => {
				ctx?.stage('Reading the toolpaths…');
				let last = -1;
				const result = await previewInWorker(entry, opts, {
					signal: ctx?.signal,
					onProgress: (f) => {
						const pct = Math.floor(f * 100);
						if (ctx && pct >= last + 5) {
							last = pct;
							ctx.stage(`Reading the toolpaths… ${pct} %`);
						}
					}
				}).catch((error: Error) => {
					throw error.message === 'Stopped' ? error : new AppError(422, error.message);
				});
				return this.store(source, cache, result);
			});

		if (found.size <= (this.opts.largeBytes ?? LARGE_GCODE_BYTES)) {
			const done = make();
			this.track(cache, done, null);
			return { bytes: await done };
		}
		let resolveDone!: (b: Buffer) => void, rejectDone!: (e: unknown) => void;
		const done = new Promise<Buffer>((ok, fail) => ((resolveDone = ok), (rejectDone = fail)));
		done.catch(() => {}); // the task reports failures
		const task = this.tasks.start(
			{
				kind: 'gcode-preview',
				title: `Preview ${sliced.name.replace(/\.gcode\.3mf$|\.3mf$/i, '')}${sliced.plates.length > 1 ? ` plate ${plate}` : ''}`,
				projectId: job.projectId,
				stage: 'Waiting for another preview…'
			},
			async (ctx) => {
				try {
					const bytes = await make(ctx);
					resolveDone(bytes);
					return bytes.length;
				} catch (error) {
					rejectDone(error);
					throw error;
				}
			},
			() => ({ stage: 'Toolpaths ready' })
		);
		this.track(cache, done, task.id);
		return { taskId: task.id };
	}

	private track(cache: string, done: Promise<Buffer>, taskId: string | null) {
		this.making.set(cache, { done, taskId });
		const clear = () => this.making.delete(cache);
		done.then(clear, (error: Error) => {
			clear();
			// A stopped task may run again; a file that cannot be read stays that way.
			if (error?.message !== 'Stopped') this.failed.set(cache, error?.message || 'Unreadable.');
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	/** Writes the cache atomically, unless the sliced file went away meanwhile (then no orphan is left). */
	private async store(source: string, cache: string, result: WorkerResult): Promise<Buffer> {
		const bytes = Buffer.from(
			result.bytes.buffer,
			result.bytes.byteOffset,
			result.bytes.byteLength
		);
		if (!fs.existsSync(source)) return bytes;
		const tmp = `${cache}.tmp`;
		await fs.promises.writeFile(tmp, bytes);
		await fs.promises.rename(tmp, cache);
		if (!fs.existsSync(source)) await fs.promises.rm(cache, { force: true });
		return bytes;
	}
}
