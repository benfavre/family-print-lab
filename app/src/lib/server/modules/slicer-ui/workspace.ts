// The slicer workspace's server side: runs the engine on a saved slicer project (slicer-3mf) for the
// workspace's buttons — arrange, orient, slice a plate — and keeps each sliced plate with its toolpath
// preview until the project changes, so it can be previewed and sent (a new job with the file
// attached, then the print queue or the send window). Every engine call opens a short session: the
// project's meshes, the resolved presets and the Project itself are handed over (mesh.put,
// project.create, project.sync) and the project is closed again afterwards, so the engine keeps no
// state between clicks and either backend (Print Lab Slicer or the Bambu Studio command line) works.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../validation';
import { zipEntries } from '../../cad/mesh';
import { readSliced } from '../../printer/sliced';
import { previewInWorker } from '../../gcode/worker';
import { EngineError, type SlicerEngine } from '../../slicer/engine-types';
import type { Lab } from '../../lab';
import type { LivePublisher } from '../../modules';
import type { PrintFiles } from '../../printing';
import type { TaskCenter } from '../../tasks';
import type { ProjectStore } from '../../slicer3mf/store';
import type { QueueService } from '../contracts';
import { PRINTER_MODELS } from '$lib/shared/printers/models';
import { ERROR, type EngineCapability, type Progress } from '$lib/shared/slicer/protocol';
import { PREVIEW_FEATURES } from '$lib/shared/slicer/preview';
import type { ConfigValue, PresetRef, PresetSelection, Project } from '$lib/shared/slicer/project';
import type { ProfileService, ResolvedBundle } from '$lib/shared/slicer/profiles';
import type {
	ArrangeAnswer,
	BedShape,
	OrientAnswer,
	PlateResult,
	ResultsView,
	SendAnswer,
	SliceProgress,
	SlicerBackend
} from '$lib/shared/slicer-ui';

export interface WorkspaceDeps {
	lab: Lab;
	printing: PrintFiles;
	tasks: TaskCenter;
	live: LivePublisher;
	/** Where sliced plates are kept (the module's data folder). */
	dir: string;
	store(): ProjectStore | undefined;
	engine(): Promise<SlicerEngine | null>;
	profiles(): ProfileService | undefined;
	queue(): QueueService | undefined;
}

/** What slicing a plate needs from a backend. */
const TO_SLICE: EngineCapability[] = ['mesh.put', 'project.sync', 'slice', 'export.gcode3mf'];
/** Bambu Studio's default bed when a preset gives none (X1, P1 and A1 size). */
const DEFAULT_BED: BedShape = { area: [0, 0, 256, 256], height: 250, printerModel: '' };

/** A per-extruder value's first entry. */
const first = (v: ConfigValue | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** The printable area's bounds from printable_area ("0x0", "256x0", …), as upstream's BuildVolume reads it. */
export function bedFromConfig(config: Record<string, ConfigValue>): BedShape {
	const points = (Array.isArray(config.printable_area) ? config.printable_area : [])
		.map((p) => p.split('x').map(Number))
		.filter((p) => p.length === 2 && p.every(Number.isFinite));
	const height = Number(first(config.printable_height));
	return {
		area: points.length
			? [
					Math.min(...points.map((p) => p[0])),
					Math.min(...points.map((p) => p[1])),
					Math.max(...points.map((p) => p[0])),
					Math.max(...points.map((p) => p[1]))
				]
			: DEFAULT_BED.area,
		height: Number.isFinite(height) && height > 0 ? height : DEFAULT_BED.height,
		printerModel: first(config.printer_model)
	};
}

/**
 * Presets named in an imported project file (source 'project') are looked up among the system presets
 * of the same name: Bambu Studio writes the preset's name, and the file's own values travel in
 * projectConfig on top.
 */
export function asResolvable(ref: PresetRef): PresetRef {
	return ref.source === 'project' ? { kind: ref.kind, name: ref.name, source: 'system' } : ref;
}

export function selectionReady(sel: PresetSelection): string | null {
	if (!sel.printer.name) return 'Choose a printer preset first.';
	if (!sel.process.name) return 'Choose a process preset first.';
	if (!sel.filaments.length || sel.filaments.some((f) => !f.name))
		return 'Choose a filament for every slot first.';
	return null;
}

/** The catalogue model code for a printer_model name ("Bambu Lab P1S" → "C12"). */
export function modelCodeOf(printerModel: string): string | null {
	return Object.values(PRINTER_MODELS).find((m) => m.name === printerModel)?.code ?? null;
}

/** Engine errors carry plain words already. */
function friendly(e: unknown): Error {
	if (e instanceof EngineError)
		return e.code === ERROR.CANCELLED
			? new Error('Stopped')
			: new AppError(e.code === ERROR.CAPABILITY_MISSING ? 501 : 422, e.message);
	return e as Error;
}

const slug = (s: string) => s.replace(/[^\w .()+-]/g, '').trim() || 'Plate';

export class Workspace {
	/** Plates slicing now, by "<slicer project>:<plate>". */
	private slicing = new Map<string, string>();

	constructor(private d: WorkspaceDeps) {
		fs.mkdirSync(d.dir, { recursive: true });
	}

	private store(): ProjectStore {
		const s = this.d.store();
		if (!s) throw new AppError(503, 'Slicer projects are not available right now.');
		return s;
	}

	private async engine(needs: EngineCapability[]): Promise<SlicerEngine> {
		const engine = await this.d.engine();
		if (!engine)
			throw new AppError(503, 'No slicer is installed. See Integrations to add Bambu Studio.');
		const missing = needs.filter((c) => !engine.has(c));
		if (missing.length)
			throw new AppError(
				501,
				engine.info.engine === 'printlab-slicer'
					? `This version of Print Lab Slicer cannot do that yet (${missing.join(', ')}).`
					: `The Bambu Studio command line cannot do that (${missing.join(', ')}). Print Lab Slicer can.`
			);
		return engine;
	}

	// ---------- Reads ----------

	async info(): Promise<SlicerBackend> {
		const engine = await this.d.engine().catch(() => null);
		return {
			engine: engine?.info.engine ?? null,
			version: engine?.info.version ?? null,
			capabilities: engine ? [...engine.info.capabilities] : [],
			queue: !!this.d.queue(),
			profiles: !!this.d.profiles()
		};
	}

	/** The bed of a printer preset (slicer-profiles), else the usual 256 mm one. */
	bed(printer: PresetRef): BedShape {
		const profiles = this.d.profiles();
		if (!printer.name || !profiles) return DEFAULT_BED;
		try {
			return bedFromConfig(profiles.resolve(asResolvable(printer)).config);
		} catch {
			return DEFAULT_BED;
		}
	}

	private resultsDir(id: string) {
		if (!/^[\w-]{1,80}$/.test(id)) throw new AppError(400, 'Not a slicer project id.');
		return path.join(this.d.dir, id);
	}
	private plateFile(id: string, plate: number, ext: 'gcode.3mf' | 'json' | 'preview.bin') {
		return path.join(this.resultsDir(id), `plate_${plate}.${ext}`);
	}

	/** Every kept plate result of a slicer project, with the project's current revision. */
	results(id: string): ResultsView {
		const { revision } = this.store().summary(id);
		const dir = this.resultsDir(id);
		const results: PlateResult[] = [];
		for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
			if (!/^plate_\d+\.json$/.test(entry)) continue;
			try {
				results.push(JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')));
			} catch {
				// A half-written result is as good as none.
			}
		}
		return { revision, results: results.sort((a, b) => a.plate - b.plate) };
	}

	/** A plate's result if it still matches the saved project. */
	private fresh(id: string, plate: number): PlateResult {
		const view = this.results(id);
		const r = view.results.find((x) => x.plate === plate);
		if (!r) throw new AppError(404, `Plate ${plate} has not been sliced yet.`);
		if (r.revision !== view.revision)
			throw new AppError(
				409,
				`The project changed since plate ${plate} was sliced. Slice it again.`
			);
		return r;
	}

	/** The plate's toolpath preview (the 4.7.3 container). */
	preview(id: string, plate: number): Buffer {
		const r = this.results(id).results.find((x) => x.plate === plate);
		if (!r) throw new AppError(404, `Plate ${plate} has not been sliced yet.`);
		try {
			return fs.readFileSync(this.plateFile(id, plate, 'preview.bin'));
		} catch {
			throw new AppError(404, 'There is no toolpath preview for this plate.');
		}
	}

	/** The sliced plate file, to download. */
	sliced(id: string, plate: number) {
		const r = this.fresh(id, plate);
		const file = this.plateFile(id, plate, 'gcode.3mf');
		if (!fs.existsSync(file)) throw new AppError(404, 'The sliced file is missing. Slice again.');
		const name = `${slug(this.store().summary(id).name)} plate ${r.plate}.gcode.3mf`;
		return { path: file, name };
	}

	// ---------- Engine work ----------

	/** Loads the saved project, refusing when the browser's copy is not the saved one. */
	private saved(id: string, revision?: number): { project: Project; projectId: string } {
		const store = this.store();
		const summary = store.summary(id);
		if (revision !== undefined && revision !== summary.revision)
			throw new AppError(409, 'The project changed on the server. Reload it first.');
		return { project: store.read(id).project, projectId: summary.projectId };
	}

	/** The presets resolved for the engine: slicer-profiles when it runs, else the backend itself. */
	private async bundle(
		engine: SlicerEngine,
		sel: PresetSelection,
		signal?: AbortSignal
	): Promise<ResolvedBundle> {
		const missing = selectionReady(sel);
		if (missing) throw new AppError(409, missing);
		const selection: PresetSelection = {
			printer: asResolvable(sel.printer),
			process: asResolvable(sel.process),
			filaments: sel.filaments.map(asResolvable)
		};
		const profiles = this.d.profiles();
		let problem: Error | null = null;
		if (profiles) {
			try {
				return profiles.bundle(selection);
			} catch (e) {
				// The backend's own presets may still know it (they match its version).
				problem = e as Error;
			}
		}
		if (engine.has('profiles.resolve')) {
			try {
				return await engine.call('profiles.resolve', { selection }, { signal });
			} catch (e) {
				problem ??= friendly(e);
			}
		}
		if (problem)
			throw new AppError(
				409,
				`${problem.message} Pick the presets again under Printer and filaments.`
			);
		throw new AppError(503, 'This slicer cannot resolve presets. Update Print Lab Slicer.');
	}

	/**
	 * One engine session on a project: meshes in, presets resolved, the project synced; `work` gets the
	 * engine's project id; everything is closed and dropped afterwards.
	 */
	private async session<T>(
		engine: SlicerEngine,
		project: Project,
		signal: AbortSignal | undefined,
		work: (projectId: string, bundle: ResolvedBundle) => Promise<T>
	): Promise<T> {
		const store = this.store();
		const bundle = await this.bundle(engine, project.presets, signal);
		// The printer model code for the file: the preset's model (backends default to it anyway).
		const code = modelCodeOf(first(bundle.printer.config.printer_model));
		const synced: Project = code
			? {
					...project,
					meta: { ...project.meta, extras: { ...project.meta.extras, printer_model_id: code } }
				}
			: project;
		const meshIds = Object.keys(project.meshes);
		let projectId: string | null = null;
		try {
			for (const meshId of meshIds)
				await engine.call(
					'mesh.put',
					{ meshId, path: store.meshPath(meshId), format: 'stl' },
					{ signal }
				);
			projectId = (await engine.call('project.create', { presets: synced.presets })).projectId;
			const r = await engine.call(
				'project.sync',
				{ projectId, project: synced, presets: bundle },
				{ signal }
			);
			if (r.errors.length) throw new AppError(422, r.errors.map((e) => e.message).join(' '));
			return await work(projectId, bundle);
		} catch (e) {
			throw friendly(e);
		} finally {
			if (projectId) await engine.call('project.close', { projectId }).catch(() => {});
			if (meshIds.length) await engine.call('mesh.drop', { meshIds }).catch(() => {});
		}
	}

	/** Auto-arrange a plate (or every unlocked plate) the way the engine does; the browser applies the moves. */
	async arrange(
		id: string,
		o: { plate: number | 'all'; revision?: number; spacing?: number; allowRotation?: boolean }
	): Promise<ArrangeAnswer> {
		const { project } = this.saved(id, o.revision);
		const engine = await this.engine(['mesh.put', 'project.sync', 'arrange']);
		if (o.plate !== 'all' && !project.plates.some((p) => p.index === o.plate))
			throw new AppError(400, `There is no plate ${o.plate}.`);
		return this.session(engine, project, undefined, (projectId) =>
			engine.call(
				'arrange',
				{ projectId, plate: o.plate, spacing: o.spacing, allowRotation: o.allowRotation },
				{ timeoutMs: 10 * 60_000 }
			)
		);
	}

	/** Auto-orient objects (the best way up); the browser applies the new transforms. */
	async orient(id: string, o: { objectIds: string[]; revision?: number }): Promise<OrientAnswer> {
		const { project } = this.saved(id, o.revision);
		const engine = await this.engine(['mesh.put', 'project.sync', 'orient']);
		const known = new Set(project.objects.map((x) => x.id));
		const objectIds = o.objectIds.filter((x) => known.has(x));
		if (!objectIds.length) throw new AppError(400, 'Choose the objects to orient.');
		return this.session(engine, project, undefined, (projectId) =>
			engine.call('orient', { projectId, objectIds }, { timeoutMs: 10 * 60_000 })
		);
	}

	/** Slices one plate of the saved project as a background task; the result is kept for preview and send. */
	slice(id: string, o: { plate: number; revision?: number; thumbnail?: string | null }) {
		const store = this.store();
		const summary = store.summary(id);
		const { project } = this.saved(id, o.revision);
		const plate = project.plates.find((p) => p.index === o.plate);
		if (!plate) throw new AppError(400, `There is no plate ${o.plate}.`);
		if (!plate.instances.length) throw new AppError(400, `There is nothing on plate ${o.plate}.`);
		const key = `${id}:${o.plate}`;
		if (this.slicing.has(key)) throw new AppError(409, `Plate ${o.plate} is slicing already.`);
		const revision = summary.revision;
		const title = `Slice ${summary.name}${project.plates.length > 1 ? ` plate ${o.plate}` : ''}`;
		const task = this.d.tasks.start(
			{
				kind: 'slice',
				title,
				projectId: summary.projectId,
				stage: 'Getting the slicer ready…'
			},
			async (ctx) => {
				try {
					return await this.runSlice(id, project, o.plate, revision, o.thumbnail ?? null, ctx);
				} finally {
					this.slicing.delete(key);
				}
			},
			(r) => ({
				stage: `${Math.max(1, Math.round(r.stats.seconds / 60))} min · ${
					Math.round(r.stats.filaments.reduce((a, f) => a + f.grams, 0) * 10) / 10
				} g`
			})
		);
		this.slicing.set(key, task.id);
		return task;
	}

	private async runSlice(
		id: string,
		project: Project,
		plate: number,
		revision: number,
		thumbnail: string | null,
		ctx: { signal: AbortSignal; stage(text: string): void; info: { id: string } }
	): Promise<PlateResult> {
		const engine = await this.engine(TO_SLICE);
		const tmp = fs.mkdtempSync(path.join(this.d.dir, '.slice-'));
		const progress = (percent: number, message: string) => {
			ctx.stage(percent > 0 && percent < 100 ? `${message} ${Math.round(percent)} %` : message);
			const data: SliceProgress = {
				slicerProjectId: id,
				plate,
				taskId: ctx.info.id,
				percent,
				message
			};
			this.d.live.send('slicer-ui:progress', data);
		};
		try {
			progress(0, 'Handing the project to the slicer…');
			const out = path.join(tmp, 'plate.gcode.3mf');
			const previewPath = path.join(tmp, 'preview.bin');
			let enginePreview = false;
			const stats = await this.session(engine, project, ctx.signal, async (projectId) => {
				const stats = await engine.call(
					'slice',
					{ projectId, plate },
					{
						signal: ctx.signal,
						timeoutMs: 30 * 60_000,
						onProgress: (p: Progress) =>
							progress(p.percent, p.message || `${p.stage[0].toUpperCase()}${p.stage.slice(1)}…`)
					}
				);
				progress(100, 'Preparing the printer file…');
				let pictures: 'engine' | { plate: number; thumbnail: string }[] = 'engine';
				if (thumbnail) {
					const png = path.join(tmp, `plate_${plate}.png`);
					fs.writeFileSync(png, Buffer.from(thumbnail, 'base64'));
					pictures = [{ plate, thumbnail: png }];
				}
				await engine.call(
					'export.gcode3mf',
					{ projectId, plates: [plate], path: out, thumbnails: pictures },
					{ signal: ctx.signal }
				);
				if (engine.has('preview.v1')) {
					try {
						await engine.call(
							'preview.get',
							{ projectId, plate, path: previewPath },
							{ signal: ctx.signal }
						);
						enginePreview = fs.existsSync(previewPath);
					} catch {
						// The G-code parser below makes one instead.
					}
				}
				return stats;
			});
			const data = fs.readFileSync(out);
			const file = readSliced(data);
			const sliced = file.plates[0];
			if (!sliced) throw new AppError(422, 'The slicer wrote a file without a plate.');
			let preview = enginePreview;
			if (!preview) {
				progress(100, 'Reading the toolpaths…');
				preview = await this.previewFromFile(data, sliced, previewPath, ctx.signal);
			}
			const result: PlateResult = {
				plate,
				revision,
				stats: { ...stats, plate },
				sliced,
				backend: engine.info.engine,
				printerModelId: file.printerModelId,
				preview,
				at: new Date().toISOString()
			};
			// Kept only if the project is still the one that was sliced (and still exists).
			const now = this.d.store()?.summary(id);
			if (!now || now.revision !== revision)
				throw new AppError(409, 'The project changed while it was slicing. Slice it again.');
			const dir = this.resultsDir(id);
			fs.mkdirSync(dir, { recursive: true });
			for (const ext of ['json', 'preview.bin'] as const)
				fs.rmSync(this.plateFile(id, plate, ext), { force: true });
			fs.renameSync(out, this.plateFile(id, plate, 'gcode.3mf'));
			if (preview) fs.renameSync(previewPath, this.plateFile(id, plate, 'preview.bin'));
			writeAtomic(this.plateFile(id, plate, 'json'), JSON.stringify(result));
			return result;
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}

	/** Parses the plate's G-code into a preview (gcode-preview's parser, in a worker thread). */
	private async previewFromFile(
		data: Buffer,
		sliced: PlateResult['sliced'],
		target: string,
		signal: AbortSignal
	): Promise<boolean> {
		const found = zipEntries(data).find((e) => e.name === sliced.gcode);
		if (!found) return false;
		try {
			const r = await previewInWorker(
				{ raw: found.raw, method: found.method, size: found.size },
				{
					plate: sliced.index,
					features: PREVIEW_FEATURES,
					filaments: sliced.filaments
						.filter((f) => f.id >= 1)
						.map((f) => ({ index: f.id - 1, color: f.color, type: f.type }))
				},
				{ signal }
			);
			fs.writeFileSync(target, r.bytes);
			return true;
		} catch (e) {
			if (signal.aborted) throw e;
			// No preview is not a failed slice: the plate can still be sent.
			return false;
		}
	}

	/** The plate's task while it slices. */
	slicingTask(id: string, plate: number): string | null {
		return this.slicing.get(`${id}:${plate}`) ?? null;
	}

	/**
	 * A new print job for the sliced plate, the file attached; then the print queue (queue: true) or
	 * nothing more (the browser opens the send window for it).
	 */
	send(id: string, o: { plate: number; printerId: string | null; queue: boolean }): SendAnswer {
		const r = this.fresh(id, o.plate);
		const queue = this.d.queue();
		if (o.queue && !queue) throw new AppError(503, 'The print queue is not running.');
		const summary = this.store().summary(id);
		const data = fs.readFileSync(this.plateFile(id, o.plate, 'gcode.3mf'));
		const grams = Math.round(r.stats.filaments.reduce((a, f) => a + f.grams, 0) * 10) / 10;
		const jobId = this.d.lab.createJob({
			projectId: summary.projectId,
			printerId: o.printerId,
			minutes: Math.max(1, Math.round(r.stats.seconds / 60)),
			grams: grams || null,
			material: r.sliced.filaments[0]?.type ?? '',
			notes: `Sliced in the slicer from “${summary.name}”${summary.plates > 1 ? `, plate ${o.plate}` : ''}.`
		});
		try {
			this.d.printing.attach(
				jobId,
				data,
				`${slug(summary.name)}${summary.plates > 1 ? ` plate ${o.plate}` : ''}.gcode.3mf`,
				'app'
			);
			if (o.queue) queue!.enqueue(jobId, { printerId: o.printerId });
		} catch (e) {
			this.d.lab.deleteJob(jobId);
			throw e;
		}
		return { jobId, queued: o.queue };
	}

	/** Removes kept results of slicer projects that no longer exist, and stray scratch folders. */
	sweep() {
		const store = this.d.store();
		if (!store || !fs.existsSync(this.d.dir)) return;
		const live = new Set(store.list().map((s) => s.id));
		for (const entry of fs.readdirSync(this.d.dir))
			if (!live.has(entry))
				fs.rmSync(path.join(this.d.dir, entry), { recursive: true, force: true });
	}
}

function writeAtomic(file: string, text: string) {
	const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}
