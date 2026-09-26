// Sliced print files attached to jobs, and sending them to a printer as a background task: upload over
// the printer's file service, mark the job as printing on that printer (linked to its task name, with
// what was sent), then start it. If the printer refuses, the job goes back to the queue. One send at a
// time per printer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Lab } from './lab';
import type { TaskCenter } from './tasks';
import { DEVELOPER_MODE_OFF, type BambuPrinter } from './printer/bambu';
import type { PrinterManager } from './printer/manager';
import type { Hooks } from './modules';
import { readSliced } from './printer/sliced';
import type { ModelStore } from './models';
import { slice } from './slicer';
import { AppError } from './validation';
import { loadedSlots, mappingProblems } from '$lib/shared/printing';
import { ACTIVE_PRINTER_STATES, type Job, type SlicedInfo } from '$lib/shared/domain';
import { EXT_DEPUTY, EXT_MAIN } from '$lib/shared/printers/status';
import { PRINTER_MODELS, modelShort, sameModel, type ModelCode } from '$lib/shared/printers/models';

/** "a P1S", "an X2D". */
const withArticle = (name: string) => `${/^[AEFHILMNORSX]/i.test(name) ? 'an' : 'a'} ${name}`;

// Matches BODY_SIZE_LIMIT (110M); sliced plates are usually 2-40 MB.
export const MAX_SLICED_BYTES = 110 * 1000 * 1000;

/**
 * A send's mapping (one tray per filament the plate uses, in the plate's order) → project_file's: one
 * entry per filament of the project, by filament id, -1 for the ones this plate does not use (Bambu
 * Studio SelectMachine.cpp get_ams_mapping_result ~1424–1510 loops over every filament preset).
 */
type PlateFilaments = Pick<SlicedInfo['plates'][number], 'filaments'>;
export function projectMapping(
	sliced: { plates: PlateFilaments[] },
	plate: PlateFilaments,
	mapping: number[]
): number[] {
	// Files without filament ids: as given.
	if (!plate.filaments.length || plate.filaments.some((f) => !(f.id >= 1 && f.id <= 64)))
		return mapping;
	const count = Math.max(...sliced.plates.flatMap((p) => p.filaments.map((f) => f.id)));
	const out = Array<number>(count).fill(-1);
	plate.filaments.forEach((f, i) => (out[f.id - 1] = mapping[i] ?? -1));
	return out;
}

/**
 * Not feeding from the AMS on a dual-nozzle printer: each filament goes to its own nozzle's external
 * spool, the left (deputy, 254) for extruder 1 and the right (main, 255) for extruder 2, as Bambu
 * Studio's do_ams_mapping does with use_ams off (SelectMachine.cpp ~1288–1343, then
 * get_ams_mapping_result ~1463–1500 writes {254|255, 0} per filament). Single-nozzle printers, and
 * files that do not say which nozzle prints what, get the empty mapping.
 */
export function externalMapping(
	sliced: { plates: PlateFilaments[] },
	plate: PlateFilaments,
	nozzles: number
): number[] {
	if (nozzles !== 2 || !plate.filaments.length || plate.filaments.some((f) => !f.extruder))
		return [];
	return projectMapping(
		sliced,
		plate,
		plate.filaments.map((f) => (f.extruder === 1 ? EXT_DEPUTY : EXT_MAIN))
	);
}

export interface SendOptions {
	plate?: number;
	useAms: boolean;
	/** One tray per filament the plate uses, in the plate's order (sent by filament id: projectMapping). */
	amsMapping: number[];
	bedLeveling?: boolean;
	timelapse?: boolean;
	/** Send even though the check found problems (the person confirmed). */
	force?: boolean;
	/** The printer to send to (default: the job's printer, else the first one). */
	printerId?: string;
	/**
	 * Wake the printer first: with beforeDispatch hooks registered (home-automation), an offline printer
	 * is not a problem yet; the send task runs the hooks, then checks again before uploading.
	 */
	wake?: boolean;
}

export class PrintFiles {
	constructor(
		private lab: Lab,
		readonly dir: string,
		private tasks: TaskCenter,
		private printers: PrinterManager,
		private models: ModelStore,
		private hooks: Hooks
	) {}

	/** The printer model a job slices for: its printer's, else the first printer's, else the X2D. */
	private modelFor(job: Job): ModelCode {
		if (job.printerId) {
			const saved = this.printers.info().find((p) => p.id === job.printerId);
			if (saved) return saved.model;
		}
		return this.printers.primary()?.model.code ?? 'N6';
	}

	/**
	 * Slices the job's model version for its printer's model with the job's settings (Bambu Studio,
	 * headless) and attaches the result, as a background task.
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
		const printerModel = this.modelFor(job);
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
						model: printerModel,
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

	/** One send at a time per printer (a printer can only take one print), and per job. */
	private sending = new Set<string>();
	private sendingJobs = new Set<string>();

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

	/** Which printer a send goes to: the one asked for, the job's, else the first. */
	private target(job: Job, opts: SendOptions): { id: string | null; printer: BambuPrinter | null } {
		const id = opts.printerId ?? job.printerId ?? this.printers.primary()?.id ?? null;
		return { id, printer: id ? (this.printers.get(id) ?? null) : null };
	}

	/**
	 * Checks everything that can be checked before sending; returns problems in plain words. `ownSend`:
	 * the send task re-checking itself after waking the printer (its own send lock is not a problem).
	 */
	check(
		jobId: string,
		opts: SendOptions,
		ownSend = false
	): { blocking: string[]; warnings: string[] } {
		const job = this.job(jobId);
		const blocking: string[] = [],
			warnings: string[] = [];
		const { id, printer } = this.target(job, opts);
		const saved = id ? this.printers.info().find((p) => p.id === id) : undefined;
		const status = printer?.status();
		const canWake = !!opts.wake && this.hooks.beforeDispatch.size > 0;
		if (!id) blocking.push('No printer is set up yet.');
		else if (!saved) blocking.push('That printer no longer exists.');
		else if (!printer) blocking.push('That printer is switched off in Settings.');
		else if (!ownSend && this.sending.has(id))
			blocking.push('Another print is being sent to this printer right now.');
		else if (!status?.connected) {
			// With wake-up hooks the send task switches the printer on and checks again then.
			if (!canWake) blocking.push('The printer is not connected.');
		} else if (status.state && ACTIVE_PRINTER_STATES.has(status.state.gcodeState))
			blocking.push('The printer is busy with another print.');
		else if (status.state?.developerMode === false) blocking.push(DEVELOPER_MODE_OFF);
		if (job.status !== 'Queued') blocking.push('Only a queued job can be sent.');
		else if (!ownSend && this.sendingJobs.has(jobId))
			blocking.push('This job is being sent right now.');
		const sliced = job.sliced;
		if (!sliced) blocking.push('Attach a sliced file first.');
		else {
			if (!fs.existsSync(this.file(sliced.file)))
				blocking.push('The sliced file is missing (restored from a backup?). Attach it again.');
			const model = saved?.model;
			if (model && sliced.printerModelId && !sameModel(sliced.printerModelId, model))
				blocking.push(
					`This file was sliced for the ${modelShort(sliced.printerModelId)}. This printer is ${withArticle(PRINTER_MODELS[model].short)}.`
				);
			const plate = sliced.plates.find((p) => p.index === (opts.plate ?? sliced.plate));
			if (!plate) blocking.push('That plate is not in the file.');
			else if (opts.useAms) {
				if (opts.amsMapping.length !== plate.filaments.length)
					blocking.push('Choose an AMS slot for every filament.');
				else if (status?.connected)
					warnings.push(
						...mappingProblems(plate.filaments, opts.amsMapping, loadedSlots(status?.state))
					);
			}
		}
		return { blocking, warnings };
	}

	/** Sends a queued job's sliced file to a printer and starts it, as a background task. */
	send(jobId: string, opts: SendOptions) {
		const { blocking, warnings } = this.check(jobId, opts);
		if (blocking.length) throw new AppError(409, blocking[0]);
		if (warnings.length && !opts.force) throw new AppError(409, warnings.join(' '));
		const job = this.job(jobId);
		const printerId = this.target(job, opts).id!;
		const sliced = job.sliced!;
		const plate = sliced.plates.find((p) => p.index === (opts.plate ?? sliced.plate))!;
		// The printer shows and reports this name; it links the running print back to this job.
		const title = `${this.lab.projectTitle(job.projectId) ?? 'Print'} ${job.revision}`
			.replace(/[^\w .()+-]/g, '')
			.trim()
			.slice(0, 60);
		const remoteName = `${title.replace(/\s+/g, '_').slice(0, 50) || 'print'}.gcode.3mf`;
		const sendingFile = sliced.file;
		this.sending.add(printerId);
		this.sendingJobs.add(jobId);
		return this.tasks.start(
			{
				kind: 'print-send',
				title: `Print ${title}`,
				projectId: job.projectId,
				stage: opts.wake ? 'Waking the printer…' : 'Uploading to the printer…'
			},
			async (ctx) => {
				try {
					return await this.deliver(
						ctx,
						jobId,
						printerId,
						sendingFile,
						remoteName,
						title,
						plate,
						opts
					);
				} finally {
					this.sending.delete(printerId);
					this.sendingJobs.delete(jobId);
				}
			}
		);
	}

	private async deliver(
		ctx: { signal: AbortSignal; stage(text: string): void },
		jobId: string,
		printerId: string,
		file: string,
		remoteName: string,
		title: string,
		plate: SlicedInfo['plates'][number],
		opts: SendOptions
	) {
		if (opts.wake && this.hooks.beforeDispatch.size) {
			for (const hook of this.hooks.beforeDispatch.list())
				await hook({ printerId, jobId, signal: ctx.signal });
			if (ctx.signal.aborted) throw new Error('Stopped');
			// Awake now? Everything is checked again, as nothing was checked while it slept.
			const { blocking } = this.check(jobId, { ...opts, printerId, wake: false }, true);
			if (blocking.length) throw new Error(blocking[0]);
			ctx.stage('Uploading to the printer…');
		}
		const printer = this.printers.require(printerId);
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
		const amsMapping = opts.useAms
			? projectMapping(now.sliced!, plate, opts.amsMapping)
			: externalMapping(now.sliced!, plate, printer.model.nozzles);
		this.lab.startSentJob(jobId, {
			printerTask: title,
			printerId,
			dispatch: {
				printerId,
				plate: plate.index,
				useAms: opts.useAms,
				amsMapping,
				remoteName,
				at: new Date().toISOString()
			}
		});
		try {
			return await printer.startPrint({
				file: remoteName,
				plate: plate.index,
				title,
				md5: plate.md5,
				useAms: opts.useAms,
				amsMapping,
				bedLeveling: opts.bedLeveling ?? true,
				timelapse: opts.timelapse ?? false
			});
		} catch (error) {
			// Only put it back if it is still this print (the printer may have reported in since).
			const after = this.lab.getJob(jobId);
			if (after?.status === 'Printing' && after.printerTask === title)
				this.lab.transitionJob(jobId, { to: 'Queued', printerTask: '', from: 'Printing' });
			throw error;
		}
	}
}
