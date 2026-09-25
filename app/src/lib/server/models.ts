// 3D models attached to projects: parametric (OpenSCAD source) or mesh (imported/edited triangles).
// Every change creates an immutable version; each version's mesh is stored as binary STL under
// data/models/<modelId>/<versionId>.stl (plus an optional .png thumbnail).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db';
import { jobs, modelVersions, models, projects } from './db/schema';
import type { Lab } from './lab';
import { AppError } from './validation';
import {
	importMesh,
	stats,
	write3mf,
	writeStl,
	parseStl,
	type MeshFormat,
	type Soup
} from './cad/mesh';
import { renderScad, parseParameters, STARTER_SCAD, type Diagnostic } from './cad/openscad';
import { applyOp, type MeshOp } from './cad/geometry';
import * as blender from './cad/blender';
import type { TaskCenter } from './tasks';

const nowIso = () => new Date().toISOString();
type ParamValues = Record<string, string | number | boolean>;
/** A mesh edit as requested: combine names the other model instead of carrying its mesh. */
export type MeshOpRequest =
	| Exclude<MeshOp, { op: 'combine' }>
	| { op: 'combine'; mode: 'union' | 'subtract' | 'intersect'; otherModelId: string };
const uuid = () => crypto.randomUUID();

export class RenderFailed extends AppError {
	constructor(readonly diagnostics: Diagnostic[]) {
		super(
			422,
			diagnostics.find((d) => d.level === 'error')?.message ?? 'The model does not render.'
		);
	}
}

export class ModelStore {
	private sessions = new Map<string, blender.Session>();

	constructor(
		private db: DB,
		private lab: Lab,
		readonly dir: string,
		private tasks: TaskCenter | null = null
	) {
		fs.mkdirSync(dir, { recursive: true });
	}

	// ---------- Reads ----------

	model(id: string) {
		const m = this.db.select().from(models).where(eq(models.id, id)).get();
		if (!m) throw new AppError(404, 'That model no longer exists.');
		return m;
	}

	version(modelId: string, versionId: string) {
		const v = this.db
			.select()
			.from(modelVersions)
			.where(and(eq(modelVersions.id, versionId), eq(modelVersions.modelId, modelId)))
			.get();
		if (!v) throw new AppError(404, 'That model version no longer exists.');
		return v;
	}

	/** Full detail for the editor, including sources and parameters. */
	detail(id: string) {
		const model = this.model(id);
		const versions = this.db
			.select()
			.from(modelVersions)
			.where(eq(modelVersions.modelId, id))
			.orderBy(desc(modelVersions.number))
			.all();
		const current = versions.find((v) => v.id === model.currentVersionId) ?? versions[0];
		return {
			model,
			versions,
			current,
			parameters: model.kind === 'parametric' && current ? parseParameters(current.source) : [],
			editing: this.sessions.has(id)
		};
	}

	path(modelId: string, versionId: string, ext = 'stl') {
		return path.join(this.dir, modelId, `${versionId}.${ext}`);
	}

	soup(modelId: string, versionId: string): Soup {
		return parseStl(fs.readFileSync(this.path(modelId, versionId)));
	}

	/** Mesh download in STL or 3MF. */
	file(modelId: string, versionId: string, format: 'stl' | '3mf') {
		const model = this.model(modelId);
		const version = this.version(modelId, versionId);
		const stl = fs.readFileSync(this.path(modelId, version.id));
		const base = `${model.name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'model'}-v${version.number}`;
		return format === 'stl'
			? { data: stl, name: `${base}.stl`, type: 'model/stl' }
			: { data: write3mf(parseStl(stl), model.name), name: `${base}.3mf`, type: 'model/3mf' };
	}

	// ---------- Writes ----------

	/** Stores a mesh as a new version and makes it current. */
	private addVersion(
		modelId: string,
		soup: Soup,
		fields: { source?: string; params?: ParamValues; note?: string; origin: string }
	) {
		const s = stats(soup);
		if (!s.triangles) throw new AppError(422, 'The result has no geometry.');
		const id = uuid();
		fs.mkdirSync(path.join(this.dir, modelId), { recursive: true });
		fs.writeFileSync(this.path(modelId, id), writeStl(soup));
		const model = this.model(modelId);
		try {
			this.db.transaction((tx) => {
				const n =
					(tx
						.select({ n: sql<number>`coalesce(max(${modelVersions.number}), 0)` })
						.from(modelVersions)
						.where(eq(modelVersions.modelId, modelId))
						.get()?.n ?? 0) + 1;
				tx.insert(modelVersions)
					.values({
						id,
						modelId,
						number: n,
						source: fields.source ?? '',
						params: fields.params ?? {},
						file: `${id}.stl`,
						note: fields.note ?? '',
						origin: fields.origin,
						triangles: s.triangles,
						sizeX: s.size[0],
						sizeY: s.size[1],
						sizeZ: s.size[2],
						volume: s.volume
					})
					.run();
				tx.update(models)
					.set({ currentVersionId: id, updatedAt: nowIso(), version: sql`${models.version} + 1` })
					.where(eq(models.id, modelId))
					.run();
			});
		} catch (error) {
			fs.rmSync(this.path(modelId, id), { force: true });
			throw error;
		}
		this.lab.touch('model', `${model.name}: ${fields.note || 'new version'}`, model.projectId);
		return id;
	}

	private create(projectId: string, name: string, kind: 'parametric' | 'mesh') {
		if (!this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get())
			throw new AppError(404, 'That project no longer exists.');
		const clean = name.trim().slice(0, 80);
		if (!clean) throw new AppError(400, 'Give the model a name.');
		const id = uuid();
		this.db.insert(models).values({ id, projectId, name: clean, kind }).run();
		return id;
	}

	async createParametric(
		projectId: string,
		name: string,
		source = STARTER_SCAD,
		origin = 'editor',
		note = 'Created'
	) {
		const render = await renderScad(source);
		if (!render.soup) throw new RenderFailed(render.diagnostics);
		const id = this.create(projectId, name, 'parametric');
		this.addVersion(id, render.soup, { source, params: {}, note, origin });
		return id;
	}

	async saveParametric(
		modelId: string,
		input: { source: string; params: ParamValues; note?: string; origin?: string }
	) {
		const model = this.model(modelId);
		if (model.kind !== 'parametric')
			throw new AppError(400, 'Only parametric models have source code.');
		const render = await renderScad(input.source, input.params);
		if (!render.soup) throw new RenderFailed(render.diagnostics);
		return this.addVersion(modelId, render.soup, {
			source: input.source,
			params: input.params,
			note: input.note || 'Saved',
			origin: input.origin ?? 'editor'
		});
	}

	importFile(projectId: string, name: string, buf: Buffer, format: MeshFormat) {
		const soup = importMesh(buf, format);
		const id = this.create(projectId, name, 'mesh');
		try {
			this.addVersion(id, soup, { note: `Imported ${format.toUpperCase()}`, origin: 'upload' });
		} catch (error) {
			this.db.delete(models).where(eq(models.id, id)).run();
			throw error;
		}
		return id;
	}

	/** Copies a parametric model's current shape into a new mesh model for mesh tools and Blender. */
	meshCopy(modelId: string) {
		const { model, current } = this.detail(modelId);
		if (!current) throw new AppError(404, 'Nothing to copy yet.');
		const id = this.create(model.projectId, `${model.name} (mesh)`.slice(0, 80), 'mesh');
		this.addVersion(id, this.soup(modelId, current.id), {
			note: `Copied from ${model.name} v${current.number}`,
			origin: 'copy'
		});
		return id;
	}

	async op(modelId: string, op: MeshOpRequest) {
		const { model, current } = this.detail(modelId);
		if (model.kind !== 'mesh')
			throw new AppError(
				400,
				'Use “Make mesh copy” first; parametric models change through their parameters and code.'
			);
		if (!current) throw new AppError(404, 'Nothing to edit yet.');
		let resolved: MeshOp;
		if (op.op === 'combine') {
			const other = this.detail(op.otherModelId);
			if (!other.current) throw new AppError(404, 'The other model has no geometry.');
			resolved = {
				op: 'combine',
				mode: op.mode,
				other: this.soup(other.model.id, other.current.id)
			};
		} else resolved = op;
		const result = await applyOp(this.soup(modelId, current.id), resolved);
		const note = {
			scale: 'Scaled',
			rotate: 'Rotated',
			mirror: 'Mirrored',
			center: 'Centered on the bed',
			layFlat: 'Laid flat',
			autoOrient: 'Auto-oriented for printing',
			text: 'Added text',
			copies: 'Made copies',
			cut: 'Cut',
			drill: 'Drilled a hole',
			combine: 'Combined with another model'
		}[op.op];
		const specific =
			op.op === 'text'
				? `${op.mode === 'emboss' ? 'Raised' : 'Engraved'} text “${op.text.trim()}”`
				: op.op === 'copies'
					? `${op.count} copies on one plate`
					: op.op === 'cut' && op.keep === 'both'
						? `Cut in two at ${op.axis.toUpperCase()} = ${+op.at.toFixed(1)} mm, both pieces flat on the plate`
						: note;
		return this.addVersion(modelId, result, { note: specific, origin: 'mesh-op' });
	}

	async blenderJob(modelId: string, job: 'repair' | 'decimate', ratio = 0.5) {
		const { model, current } = this.detail(modelId);
		if (!current) throw new AppError(404, 'Nothing to process yet.');
		if (model.kind === 'parametric')
			throw new AppError(400, 'Make a mesh copy first to process it in Blender.');
		const out = path.join(this.dir, modelId, `blender-${uuid()}.stl`);
		const work = async (stage: (text: string) => void = () => {}) => {
			stage(
				job === 'repair'
					? 'Repairing in Blender…'
					: `Simplifying to ${Math.round(ratio * 100)}% in Blender…`
			);
			const report = await blender.runJob(
				job,
				this.path(modelId, current.id),
				out,
				job === 'decimate' ? [String(ratio)] : []
			);
			stage('Saving the new version…');
			const soup = parseStl(fs.readFileSync(out));
			report.faces_after = soup.length / 9;
			const note =
				job === 'repair'
					? `Repaired in Blender (${report.holes_filled ?? 0} holes filled, ${report.non_manifold_edges ?? 0} open edges left)`
					: `Simplified in Blender to ${Math.round(Number(report.ratio) * 100)}%`;
			return { versionId: this.addVersion(modelId, soup, { note, origin: 'blender' }), report };
		};
		try {
			if (!this.tasks) return await work();
			return await this.tasks.run(
				{
					kind: job === 'repair' ? 'blender-repair' : 'blender-decimate',
					title: `${job === 'repair' ? 'Repair' : 'Simplify'} “${model.name}”`,
					projectId: model.projectId,
					modelId
				},
				(ctx) => work(ctx.stage),
				(r) => ({ versionId: r.versionId })
			);
		} finally {
			fs.rmSync(out, { force: true });
		}
	}

	openInBlender(modelId: string) {
		const { model, current } = this.detail(modelId);
		if (!current) throw new AppError(404, 'Nothing to open yet.');
		if (this.sessions.has(modelId))
			throw new AppError(409, 'This model is already open in Blender.');
		const target = model.kind === 'mesh' ? modelId : this.meshCopy(modelId);
		const targetModel = this.model(target);
		// The open window is a task too, so every tab shows it and each save is reported as it lands.
		let saves = 0;
		const task = this.tasks?.open(
			{
				kind: 'blender-session',
				title: `“${targetModel.name}” open in Blender`,
				projectId: targetModel.projectId,
				modelId: target,
				stage: 'Starting Blender…'
			},
			() => this.sessions.get(target)?.stop()
		);
		const session = blender.openSession({
			modelId: target,
			name: targetModel.name,
			input: this.path(target, this.detail(target).current!.id),
			workDir: path.join(this.dir, target, 'blender'),
			onSave: (file) => {
				try {
					const id = this.addVersion(target, parseStl(fs.readFileSync(file)), {
						note: 'Saved from Blender',
						origin: 'blender'
					});
					saves++;
					task?.stage(
						`Imported ${saves} ${saves === 1 ? 'save' : 'saves'} as new versions — keep going, or close Blender when done`
					);
					return this.path(target, id);
				} catch (error) {
					console.error('[print-lab] Could not import the Blender save:', (error as Error).message);
				}
			},
			onStatus: (text, problem) => {
				if (problem) {
					task?.stage(`Blender: ${text}`);
					console.error(`[print-lab] Blender session for ${targetModel.name}: ${text}`);
				} else if (text === 'session ready')
					task?.stage('Open in Blender — save there (Ctrl+S) to bring changes back');
			},
			onClose: () => {
				this.sessions.delete(target);
				task?.end();
				this.lab.touch('model');
			}
		});
		this.sessions.set(target, session);
		this.lab.touch('model', `${targetModel.name}: opened in Blender`, targetModel.projectId);
		return { modelId: target };
	}

	restore(modelId: string, versionId: string) {
		const model = this.model(modelId);
		const v = this.version(modelId, versionId);
		this.db
			.update(models)
			.set({ currentVersionId: v.id, updatedAt: nowIso(), version: sql`${models.version} + 1` })
			.where(eq(models.id, modelId))
			.run();
		this.lab.touch('model', `${model.name}: restored v${v.number}`, model.projectId);
	}

	rename(modelId: string, name: string) {
		const clean = name.trim().slice(0, 80);
		if (!clean) throw new AppError(400, 'Give the model a name.');
		this.model(modelId);
		this.db
			.update(models)
			.set({ name: clean, updatedAt: nowIso() })
			.where(eq(models.id, modelId))
			.run();
		this.lab.touch('model');
	}

	remove(modelId: string) {
		const model = this.model(modelId);
		this.sessions.get(modelId)?.stop();
		this.db.transaction((tx) => {
			const ids = tx
				.select({ id: modelVersions.id })
				.from(modelVersions)
				.where(eq(modelVersions.modelId, modelId))
				.all()
				.map((v) => v.id);
			if (ids.length)
				tx.update(jobs)
					.set({ modelVersionId: null })
					.where(inArray(jobs.modelVersionId, ids))
					.run();
			tx.delete(models).where(eq(models.id, modelId)).run();
		});
		fs.rmSync(path.join(this.dir, modelId), { recursive: true, force: true });
		this.lab.touch('model', `Deleted model “${model.name}”`, model.projectId);
	}

	/** Stores a version's thumbnail: the PNG (also the printer's plate picture) or the app's small WebP. */
	saveThumbnail(modelId: string, versionId: string, image: Buffer, kind: 'png' | 'webp' = 'png') {
		this.version(modelId, versionId);
		const ok =
			kind === 'png'
				? image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
				: image.subarray(0, 4).toString() === 'RIFF' && image.subarray(8, 12).toString() === 'WEBP';
		if (image.length > 2_000_000 || !ok)
			throw new AppError(400, `Thumbnails must be ${kind.toUpperCase()} images under 2 MB.`);
		fs.writeFileSync(this.path(modelId, versionId, kind), image);
		if (kind === 'webp') return;
		this.db
			.update(modelVersions)
			.set({ hasThumbnail: true })
			.where(eq(modelVersions.id, versionId))
			.run();
	}

	/** Removes model folders whose model rows are gone (after project deletes or restores). */
	sweep() {
		if (!fs.existsSync(this.dir)) return;
		const known = new Set(
			this.db
				.select({ id: models.id })
				.from(models)
				.all()
				.map((m) => m.id)
		);
		for (const entry of fs.readdirSync(this.dir))
			if (!known.has(entry))
				fs.rmSync(path.join(this.dir, entry), { recursive: true, force: true });
	}
}
