// Sliced print files attached to jobs, and sending them to the printer as a background task:
// upload over the printer's file service, mark the job as printing (linked to the printer's task
// name), then start it. If the printer refuses, the job goes back to the queue.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Lab } from './lab';
import type { TaskCenter } from './tasks';
import type { BambuPrinter } from './printer/bambu';
import { readSliced } from './printer/sliced';
import type { ModelStore } from './models';
import { slice } from './slicer';
import { AppError } from './validation';
import { loadedSlots, mappingProblems } from '$lib/shared/printing';
import { ACTIVE_PRINTER_STATES, type Job, type SlicedInfo } from '$lib/shared/domain';

// Matches BODY_SIZE_LIMIT (110M); sliced plates are usually 2-40 MB.
export const MAX_SLICED_BYTES = 110 * 1000 * 1000;

export interface SendOptions {
	plate?: number;
	useAms: boolean;
	amsMapping: number[];
	bedLeveling?: boolean;
	timelapse?: boolean;
	/** Send even though the check found problems (the person confirmed). */
	force?: boolean;
}

export class PrintFiles {
	constructor(
		private lab: Lab,
		readonly dir: string,
		private tasks: TaskCenter,
		private printer: BambuPrinter | null,
		private models: ModelStore
	) {}

	/**
	 * Slices the job's model version for the X2D with the job's settings (Bambu Studio, headless) and
	 * attaches the result, as a background task.
	 */
	sliceJob(jobId: string) {
		const job = this.job(jobId);
		if (job.status !== 'Queued') throw new AppError(409, 'Only a queued job can be sliced.');
		if (!job.modelVersionId)
			throw new AppError(409, 'Link the job to a model version first (Model in the job editor).');
		const ws = this.lab.snapshot(); // needs models and spools; slicing is rare
		const model = ws.models.find((m) => m.versions.some((v) => v.id === job.modelVersionId));
		const version = model?.versions.find((v) => v.id === job.modelVersionId);
		if (!model || !version) throw new AppError(404, 'That model version no longer exists.');
		const spool = ws.spools.find((sp) => sp.id === job.spoolId);
		const stlPath = this.models.path(model.id, version.id);
		const pngPath = this.models.path(model.id, version.id, 'png');
		return this.tasks.start(
			{
				kind: 'slice',
				title: `Slice ${model.name} v${version.number}`,
				projectId: job.projectId,
				modelId: model.id,
				stage: 'Choosing Bambu Studio profiles…'
			},
			async (ctx) => {
				const r = await slice({
					stl: fs.readFileSync(stlPath),
					name: model.name,
					thumbnail: fs.existsSync(pngPath) ? fs.readFileSync(pngPath) : null,
					settings: {
						nozzle: job.nozzle || '0.4',
						layerHeight: job.layerHeight || '0.20',
						material: job.material || spool?.material || 'PLA',
						supports: (job.supports as 'None' | 'Normal' | 'Tree') || 'None',
						infill: job.infill,
						plate: job.plate || 'Textured PEI',
						color: spool?.colorHex ?? null
					},
					signal: ctx.signal,
					onStage: ctx.stage
				});
				ctx.stage('Attaching to the job…');
				this.attach(jobId, r.data, `${model.name} v${version.number}.gcode.3mf`, 'app');
				return r;
			},
			(r) => ({
				stage: `${Math.round(r.minutes)} min · ${r.grams} g · ${r.choice.process} · ${r.choice.filament.replace(/ @BBL.*$/, '')}`
			})
		);
	}

	/** One send at a time: the printer can only take one print. */
	private sending = false;

	private job(id: string): Job {
		const job = this.lab.getJob(id);
		if (!job) throw new AppError(404, 'That print job no longer exists.');
		return job;
	}

	file(name: string): string {
		if (!/^[\w-]+\.gcode\.3mf$/.test(name)) throw new AppError(400, 'Unknown file.');
		return path.join(this.dir, name);
	}

	thumbnail(name: string, plate: number): Buffer | null {
		const p = `${this.file(name)}.plate${Math.max(1, Math.floor(plate))}.png`;
		return fs.existsSync(p) ? fs.readFileSync(p) : null;
	}

	/** Stores a sliced file for a queued job; returns what it holds. */
	attach(
		jobId: string,
		data: Buffer,
		originalName: string,
		source: SlicedInfo['source'] = 'upload'
	) {
		const job = this.job(jobId);
		if (job.status !== 'Queued')
			throw new AppError(409, 'Only a queued job can take a sliced file.');
		if (data.length > MAX_SLICED_BYTES) throw new AppError(413, 'That file is too large.');
		const parsed = readSliced(data);
		const name = `${jobId.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}.gcode.3mf`;
		fs.mkdirSync(this.dir, { recursive: true });
		const target = this.file(name);
		fs.writeFileSync(`${target}.tmp`, data);
		fs.renameSync(`${target}.tmp`, target);
		for (const [plate, png] of parsed.thumbnails)
			fs.writeFileSync(`${target}.plate${plate}.png`, png);
		const info: SlicedInfo = {
			file: name,
			name: originalName.replace(/[^\w .()+-]/g, '').slice(0, 120) || 'print.gcode.3mf',
			size: data.length,
			plates: parsed.plates,
			plate: parsed.plates[0].index,
			printerModelId: parsed.printerModelId,
			slicer: parsed.slicer,
			source,
			at: new Date().toISOString()
		};
		this.lab.setJobSliced(jobId, info);
		this.sweep();
		return info;
	}

	choosePlate(jobId: string, plate: number) {
		const job = this.job(jobId);
		if (!job.sliced?.plates.some((p) => p.index === plate))
			throw new AppError(400, 'That plate is not in the file.');
		this.lab.setJobSliced(jobId, { ...job.sliced, plate });
	}

	detach(jobId: string) {
		this.job(jobId);
		this.lab.setJobSliced(jobId, null);
		this.sweep();
	}

	/** Deletes stored files no job refers to any more. */
	sweep() {
		if (!fs.existsSync(this.dir)) return;
		const used = this.lab.slicedFilesInUse();
		for (const f of fs.readdirSync(this.dir)) {
			const base = f.match(/^([\w-]+\.gcode\.3mf)/)?.[1];
			if (base && !used.has(base)) fs.rmSync(path.join(this.dir, f), { force: true });
		}
	}

	/** Checks everything that can be checked before sending; returns problems in plain words. */
	check(jobId: string, opts: SendOptions): { blocking: string[]; warnings: string[] } {
		const job = this.job(jobId);
		const blocking: string[] = [],
			warnings: string[] = [];
		const status = this.printer?.status();
		if (!this.printer) blocking.push('No printer is set up yet.');
		else if (this.sending) blocking.push('Another print is being sent right now.');
		else if (!status?.connected) blocking.push('The printer is not connected.');
		else if (status.state && ACTIVE_PRINTER_STATES.has(status.state.gcodeState))
			blocking.push('The printer is busy with another print.');
		if (job.status !== 'Queued') blocking.push('Only a queued job can be sent.');
		const sliced = job.sliced;
		if (!sliced) blocking.push('Attach a sliced file first.');
		else {
			if (!fs.existsSync(this.file(sliced.file)))
				blocking.push('The sliced file is missing (restored from a backup?). Attach it again.');
			if (sliced.printerModelId && sliced.printerModelId !== 'N6')
				blocking.push(
					'This file was sliced for another printer model. Slice it for the Bambu Lab X2D.'
				);
			const plate = sliced.plates.find((p) => p.index === (opts.plate ?? sliced.plate));
			if (!plate) blocking.push('That plate is not in the file.');
			else if (opts.useAms) {
				if (opts.amsMapping.length !== plate.filaments.length)
					blocking.push('Choose an AMS slot for every filament.');
				else
					warnings.push(
						...mappingProblems(plate.filaments, opts.amsMapping, loadedSlots(status?.state))
					);
			}
		}
		return { blocking, warnings };
	}

	/** Sends a queued job's sliced file to the printer and starts it, as a background task. */
	send(jobId: string, opts: SendOptions) {
		const { blocking, warnings } = this.check(jobId, opts);
		if (blocking.length) throw new AppError(409, blocking[0]);
		if (warnings.length && !opts.force) throw new AppError(409, warnings.join(' '));
		const job = this.job(jobId);
		const sliced = job.sliced!;
		const plate = sliced.plates.find((p) => p.index === (opts.plate ?? sliced.plate))!;
		// The printer shows and reports this name; it links the running print back to this job.
		const title = `${this.lab.projectTitle(job.projectId) ?? 'Print'} ${job.revision}`
			.replace(/[^\w .()+-]/g, '')
			.trim()
			.slice(0, 60);
		const remoteName = `${title.replace(/\s+/g, '_').slice(0, 50) || 'print'}.gcode.3mf`;
		const sendingFile = sliced.file;
		this.sending = true;
		return this.tasks.start(
			{
				kind: 'print-send',
				title: `Print ${title}`,
				projectId: job.projectId,
				stage: 'Uploading to the printer…'
			},
			async (ctx) => {
				try {
					return await this.deliver(ctx, jobId, sendingFile, remoteName, title, plate, opts);
				} finally {
					this.sending = false;
				}
			}
		);
	}

	private async deliver(
		ctx: { signal: AbortSignal; stage(text: string): void },
		jobId: string,
		file: string,
		remoteName: string,
		title: string,
		plate: SlicedInfo['plates'][number],
		opts: SendOptions
	) {
		const printer = this.printer!;
		const data = fs.readFileSync(this.file(file));
		let last = -1;
		await printer.upload(
			remoteName,
			data,
			(f) => {
				const pct = Math.floor(f * 100);
				if (pct >= last + 5) {
					last = pct;
					ctx.stage(`Uploading to the printer… ${pct} %`);
				}
			},
			ctx.signal
		);
		if (ctx.signal.aborted) throw new Error('Stopped');
		// Changed while uploading (cancelled, another file attached)? Then do not start it.
		const now = this.lab.getJob(jobId);
		if (!now || now.status !== 'Queued' || now.sliced?.file !== file)
			throw new Error('The job changed while it was being sent; nothing was started.');
		ctx.stage('Starting the print…');
		this.lab.transitionJob(jobId, { to: 'Printing', printerTask: title, from: 'Queued' });
		try {
			const outcome = await printer.startPrint({
				file: remoteName,
				plate: plate.index,
				title,
				md5: plate.md5,
				useAms: opts.useAms,
				amsMapping: opts.useAms ? opts.amsMapping : [],
				bedLeveling: opts.bedLeveling ?? true,
				timelapse: opts.timelapse ?? false
			});
			return outcome;
		} catch (error) {
			// Only put it back if it is still this print (the printer may have reported in since).
			const after = this.lab.getJob(jobId);
			if (after?.status === 'Printing' && after.printerTask === title)
				this.lab.transitionJob(jobId, { to: 'Queued', printerTask: '', from: 'Printing' });
			throw error;
		}
	}
}
