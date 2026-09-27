// ProjectStore: slicer projects on disk. Each is a Bambu Studio project file, <id>.3mf, in the module's
// projects/ folder (an imported file is kept exactly as it came until the first save), with a small
// <id>.json beside it listing what it uses. Meshes are stored once by content as meshes/<sha256>.stl
// (the MeshId) and large passthrough files as blobs/<sha256>.bin, so the browser never has to carry
// them. Files no project uses are swept at start-up, like model folders.
import { and, asc, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db';
import { models, modelVersions, projects, slicerProjects } from '../db/schema';
import type { Lab } from '../lab';
import type { ModelStore } from '../models';
import { AppError } from '../validation';
import { importMesh, type MeshFormat, type Soup } from '../cad/mesh';
import { read3mf } from './read';
import { write3mf } from './write';
import {
	canonicalStl,
	fromSoup,
	geometryFromStl,
	meshIdOf,
	meshInfo,
	type MeshGeometry
} from './mesh';
import {
	IDENTITY,
	emptyProject,
	type MeshId,
	type MeshRef,
	type PresetSelection,
	type Project,
	type SceneObject
} from '$lib/shared/slicer/project';
import type { SlicerProjectSummary } from '$lib/shared/slicer-3mf';
import type { ProjectStoreService } from '../modules/contracts';

/** Passthrough files larger than this live in blobs/ and travel as `{ path }`. */
const BLOB_BYTES = 256 * 1024;
/** Unused files younger than this survive a sweep (an upload waiting for its first save). */
const SWEEP_GRACE_MS = 24 * 3600_000;
// Under BODY_SIZE_LIMIT (110M, .env.example), like sliced plates.
export const MAX_PROJECT_BYTES = 100_000_000;

interface Sidecar {
	meshes: MeshId[];
	blobs: string[];
	objects: number;
	plates: number;
	parts: number;
	title: string;
}

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

export const NO_PRESETS: PresetSelection = {
	printer: { kind: 'printer', name: '', source: 'project' },
	process: { kind: 'process', name: '', source: 'project' },
	filaments: []
};

/** The contract's ProjectStoreService (load/save) plus what the routes need. */
export class ProjectStore implements ProjectStoreService {
	readonly projectsDir: string;
	readonly meshDir: string;
	readonly blobDir: string;
	private refs = new Map<MeshId, MeshRef>();

	constructor(
		private db: DB,
		private lab: Lab,
		private models: ModelStore,
		dir: string,
		private blobBytes = BLOB_BYTES
	) {
		this.projectsDir = path.join(dir, 'projects');
		this.meshDir = path.join(dir, 'meshes');
		this.blobDir = path.join(dir, 'blobs');
		for (const d of [this.projectsDir, this.meshDir, this.blobDir])
			fs.mkdirSync(d, { recursive: true });
	}

	// ---------- Reads ----------

	private row(id: string) {
		const row = this.db.select().from(slicerProjects).where(eq(slicerProjects.id, id)).get();
		if (!row) throw new AppError(404, 'That slicer project no longer exists.');
		return row;
	}

	private sidecar(id: string): Sidecar | null {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.projectsDir, `${id}.json`), 'utf8'));
		} catch {
			return null;
		}
	}

	summary(id: string): SlicerProjectSummary {
		return this.toSummary(this.row(id));
	}

	private toSummary(row: typeof slicerProjects.$inferSelect): SlicerProjectSummary {
		const side = this.sidecar(row.id);
		let bytes = 0;
		try {
			bytes = fs.statSync(path.join(this.projectsDir, row.file)).size;
		} catch {
			// Missing file: shown as 0 bytes; loading it says so.
		}
		return {
			id: row.id,
			projectId: row.projectId,
			name: row.name,
			revision: row.revision,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			objects: side?.objects ?? 0,
			parts: side?.parts ?? 0,
			plates: side?.plates ?? 0,
			title: side?.title ?? '',
			bytes
		};
	}

	/** Every slicer project, or one project's, oldest first. */
	list(projectId?: string): SlicerProjectSummary[] {
		const q = this.db.select().from(slicerProjects);
		return (projectId ? q.where(eq(slicerProjects.projectId, projectId)) : q)
			.orderBy(asc(slicerProjects.createdAt))
			.all()
			.map((r) => this.toSummary(r));
	}

	/** The project file path and a download name. */
	file(id: string) {
		const row = this.row(id);
		const file = path.join(this.projectsDir, row.file);
		if (!fs.existsSync(file)) throw new AppError(404, 'The project file is missing.');
		const base = row.name.replace(/[^\p{L}\p{N}._ -]+/gu, '-').trim() || 'project';
		return { path: file, name: `${base}.3mf` };
	}

	/** Reads the project file into the Project model (meshes and big files land in the store). */
	async load(id: string): Promise<Project> {
		return this.read(id).project;
	}

	/** Like load, with what the reader had to work around. */
	read(id: string): { project: Project; warnings: string[] } {
		const { path: file } = this.file(id);
		return this.ingest(fs.readFileSync(file));
	}

	meshPath = (id: MeshId) => path.join(this.meshDir, `${id}.stl`);
	blobPath = (sha: string) => path.join(this.blobDir, `${sha}.bin`);

	/** A stored mesh's canonical STL. */
	meshStl(id: MeshId): Buffer {
		if (!/^[0-9a-f]{64}$/.test(id)) throw new AppError(400, 'Not a mesh id.');
		try {
			return fs.readFileSync(this.meshPath(id));
		} catch {
			throw new AppError(404, 'That mesh is not in the store.');
		}
	}

	meshRef(id: MeshId): MeshRef {
		const cached = this.refs.get(id);
		if (cached) return cached;
		const ref = meshInfo(id, geometryFromStl(this.meshStl(id)), {
			kind: 'file',
			path: this.meshPath(id)
		});
		this.refs.set(id, ref);
		return ref;
	}

	// ---------- Writes ----------

	/** Stores a mesh by content; returns its MeshRef. */
	putMesh(soup: Soup): MeshRef {
		const stl = canonicalStl(soup);
		const id = meshIdOf(stl);
		const file = this.meshPath(id);
		if (!fs.existsSync(file)) writeAtomic(file, stl);
		const ref = meshInfo(id, fromSoup(soup), { kind: 'file', path: file });
		this.refs.set(id, ref);
		return ref;
	}

	/** A model version's current mesh into the store. */
	putModelVersion(modelId: string, versionId: string): MeshRef {
		this.models.version(modelId, versionId);
		return this.putMesh(this.models.soup(modelId, versionId));
	}

	/** An uploaded STL/OBJ/3MF (all meshes of a 3MF merged) into the store. */
	putUpload(buf: Buffer, format: MeshFormat): MeshRef {
		return this.putMesh(importMesh(buf, format));
	}

	/** Saves the Project (browser JSON, already validated) as the project file (ProjectStoreService). */
	async save(id: string, project: Project): Promise<void> {
		this.saveSync(id, project);
	}

	/** Saves and returns the new summary; with `expectRevision`, refuses when someone saved since. */
	saveSync(id: string, project: Project, expectRevision?: number): SlicerProjectSummary {
		const row = this.row(id);
		if (expectRevision !== undefined && expectRevision !== row.revision)
			throw new AppError(409, 'Someone saved this project in the meantime. Reload it first.');
		const clean = this.normalise(project);
		const buf = write3mf(clean, {
			mesh: (m) => this.geometry(m),
			file: (p) => this.readBlob(p)
		});
		if (buf.length > MAX_PROJECT_BYTES) throw new AppError(413, 'That project is too large.');
		const file = `${id}.3mf`;
		writeAtomic(path.join(this.projectsDir, file), buf);
		this.writeSidecar(id, clean);
		this.db
			.update(slicerProjects)
			.set({ file, revision: row.revision + 1, updatedAt: nowIso() })
			.where(eq(slicerProjects.id, id))
			.run();
		return this.summary(id);
	}

	/** A new slicer project from a Project (browser JSON or built here). */
	create(projectId: string, name: string, project: Project): SlicerProjectSummary {
		const proj = this.projectRow(projectId);
		const id = uuid();
		const clean = this.normalise(project);
		const buf = write3mf(clean, {
			mesh: (m) => this.geometry(m),
			file: (p) => this.readBlob(p)
		});
		writeAtomic(path.join(this.projectsDir, `${id}.3mf`), buf);
		this.writeSidecar(id, clean);
		this.db
			.insert(slicerProjects)
			.values({
				id,
				projectId,
				name: name || clean.meta.title || 'Slicer project',
				file: `${id}.3mf`
			})
			.run();
		this.lab.touch('slicer-project', `Started slicer project “${name}”`, proj.id);
		return this.summary(id);
	}

	/** A project holding the given model versions, one object each, side by side on plate 1. */
	createFromModels(
		projectId: string,
		name: string | undefined,
		versions: { modelId: string; versionId: string }[],
		presets: PresetSelection = NO_PRESETS
	): SlicerProjectSummary {
		const project = emptyProject(presets);
		const named: string[] = [];
		for (const v of versions) {
			const model = this.db
				.select({ name: models.name, projectId: models.projectId })
				.from(models)
				.innerJoin(modelVersions, eq(modelVersions.modelId, models.id))
				.where(and(eq(models.id, v.modelId), eq(modelVersions.id, v.versionId)))
				.get();
			if (!model) throw new AppError(404, 'That model version no longer exists.');
			if (model.projectId !== projectId)
				throw new AppError(400, 'Models must come from the same project.');
			addObject(project, model.name, this.putModelVersion(v.modelId, v.versionId));
			named.push(model.name);
		}
		arrange(project);
		const title = name?.trim() || named.join(', ').slice(0, 120) || 'Slicer project';
		project.meta.title = title;
		return this.create(projectId, title, project);
	}

	/** Imports a project 3MF as it is (kept byte for byte until the first save), or a mesh file as a new project. */
	importFile(
		projectId: string,
		name: string,
		buf: Buffer,
		format: MeshFormat = '3mf'
	): { summary: SlicerProjectSummary; warnings: string[] } {
		const proj = this.projectRow(projectId);
		if (format !== '3mf') {
			const project = emptyProject(NO_PRESETS);
			const title = name.replace(/\.(stl|obj)$/i, '') || 'Imported model';
			project.meta.title = title;
			addObject(project, title, this.putUpload(buf, format));
			arrange(project);
			return { summary: this.create(projectId, title, project), warnings: [] };
		}
		const { project, warnings } = this.ingest(buf);
		const id = uuid();
		writeAtomic(path.join(this.projectsDir, `${id}.3mf`), buf);
		this.writeSidecar(id, project);
		const title = name.replace(/(\.gcode)?\.3mf$/i, '') || project.meta.title || 'Imported project';
		this.db
			.insert(slicerProjects)
			.values({ id, projectId, name: title.slice(0, 120), file: `${id}.3mf` })
			.run();
		this.lab.touch('slicer-project', `Imported slicer project “${title}”`, proj.id);
		return { summary: this.summary(id), warnings };
	}

	rename(id: string, name: string) {
		this.row(id);
		this.db
			.update(slicerProjects)
			.set({ name, updatedAt: nowIso() })
			.where(eq(slicerProjects.id, id))
			.run();
		return this.summary(id);
	}

	remove(id: string) {
		const row = this.row(id);
		this.db.delete(slicerProjects).where(eq(slicerProjects.id, id)).run();
		for (const f of [row.file, `${id}.json`])
			fs.rmSync(path.join(this.projectsDir, f), { force: true });
		this.lab.touch('slicer-project', `Deleted slicer project “${row.name}”`, row.projectId);
	}

	/**
	 * Removes project files without rows (after project deletes or restores) and meshes and blobs no
	 * project uses. Files younger than a day stay, so an upload waiting for its first save survives.
	 */
	sweep(now = Date.now()) {
		const rows = new Set(
			this.db
				.select({ id: slicerProjects.id })
				.from(slicerProjects)
				.all()
				.map((r) => r.id)
		);
		const meshes = new Set<string>(),
			blobs = new Set<string>();
		for (const entry of fs.readdirSync(this.projectsDir)) {
			const id = entry.replace(/\.(3mf|json|tmp-[\w-]+)$/, '');
			if (!rows.has(id)) {
				fs.rmSync(path.join(this.projectsDir, entry), { force: true });
				continue;
			}
			if (entry.endsWith('.json')) {
				const side = this.sidecar(id);
				side?.meshes.forEach((m) => meshes.add(`${m}.stl`));
				side?.blobs.forEach((b) => blobs.add(`${b}.bin`));
			}
		}
		const prune = (dir: string, keep: Set<string>) => {
			for (const entry of fs.readdirSync(dir)) {
				if (keep.has(entry)) continue;
				const file = path.join(dir, entry);
				if (now - fs.statSync(file).mtimeMs > SWEEP_GRACE_MS) fs.rmSync(file, { force: true });
			}
		};
		prune(this.meshDir, meshes);
		prune(this.blobDir, blobs);
		for (const id of this.refs.keys()) if (!fs.existsSync(this.meshPath(id))) this.refs.delete(id);
	}

	// ---------- Plumbing ----------

	private projectRow(projectId: string) {
		const proj = this.db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, projectId))
			.get();
		if (!proj) throw new AppError(404, 'That project no longer exists.');
		return proj;
	}

	/** Reads a 3MF, storing its meshes and big passthrough files. */
	private ingest(buf: Buffer) {
		const { project, meshes, warnings } = read3mf(buf, {
			meshStorage: (m) => ({ kind: 'file', path: this.meshPath(m) })
		});
		for (const [id, m] of meshes) {
			const file = this.meshPath(id);
			if (!fs.existsSync(file)) writeAtomic(file, m.stl);
			else touch(file);
		}
		for (const [name, entry] of Object.entries(project.passthrough)) {
			if (!('base64' in entry) || entry.base64.length * 0.75 < this.blobBytes) continue;
			const data = Buffer.from(entry.base64, 'base64');
			const sha = crypto.createHash('sha256').update(data).digest('hex');
			const file = this.blobPath(sha);
			if (!fs.existsSync(file)) writeAtomic(file, data);
			else touch(file);
			project.passthrough[name] = { path: file };
		}
		return { project, warnings };
	}

	private geometry(id: MeshId): MeshGeometry {
		return geometryFromStl(this.meshStl(id));
	}

	/** Only blobs of this store (a browser cannot make the server read other files). */
	private readBlob(p: string): Buffer {
		const name = path.basename(p);
		if (
			path.resolve(p) !== this.blobPath(name.replace(/\.bin$/, '')) ||
			!/^[0-9a-f]{64}\.bin$/.test(name)
		)
			throw new AppError(400, 'A kept file points outside the project store.');
		try {
			return fs.readFileSync(p);
		} catch {
			throw new AppError(400, 'A kept file of this project is missing.');
		}
	}

	/** Mesh references rebuilt from the store (never trusted from the browser), only the ones in use. */
	private normalise(project: Project): Project {
		const used = new Set(project.objects.flatMap((o) => o.parts.map((p) => p.mesh)));
		const meshes: Project['meshes'] = {};
		for (const id of used) {
			try {
				meshes[id] = this.meshRef(id);
			} catch {
				throw new AppError(400, 'The project uses a mesh that is not in the store. Add it first.');
			}
		}
		const objectIds = new Set<string>();
		for (const o of project.objects) {
			if (objectIds.has(o.id)) throw new AppError(400, `Two objects share the id ${o.id}.`);
			objectIds.add(o.id);
		}
		for (const [name, entry] of Object.entries(project.passthrough))
			if ('path' in entry) this.readBlob(entry.path);
			else if (!name || name.includes('..') || name.startsWith('/'))
				throw new AppError(400, 'A kept file has a bad name.');
		return { ...project, meshes };
	}

	private writeSidecar(id: string, project: Project) {
		const side: Sidecar = {
			meshes: Object.keys(project.meshes),
			blobs: Object.values(project.passthrough)
				.filter((e): e is { path: string } => 'path' in e)
				.map((e) => path.basename(e.path, '.bin')),
			objects: project.objects.length,
			parts: project.objects.reduce((n, o) => n + o.parts.length, 0),
			plates: project.plates.length,
			title: project.meta.title
		};
		writeAtomic(path.join(this.projectsDir, `${id}.json`), Buffer.from(JSON.stringify(side)));
	}
}

function writeAtomic(file: string, data: Buffer) {
	const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function touch(file: string) {
	const t = new Date();
	try {
		fs.utimesSync(file, t, t);
	} catch {
		// Best effort: only delays a sweep.
	}
}

/** Adds an object with one part (the mesh) and one instance, and puts that instance on plate 1. */
export function addObject(project: Project, name: string, mesh: MeshRef): SceneObject {
	const n = project.objects.length + 1;
	const id = `o${n}`;
	const obj: SceneObject = {
		id,
		name,
		parts: [
			{ id: `${id}-p1`, name, type: 'model', mesh: mesh.id, transform: [...IDENTITY], config: {} }
		],
		instances: [{ id: `${id}-i1`, transform: [...IDENTITY], printable: true }],
		config: {},
		heightRanges: [],
		printable: true
	};
	project.meshes[mesh.id] = mesh;
	project.objects.push(obj);
	project.plates[0].instances.push({ objectId: id, instanceId: `${id}-i1` });
	return obj;
}

/**
 * Places every object's first instance in a row around the middle of a 256 mm bed (the X1, P1 and
 * A1 size; the slicer re-arranges for other printers), resting on the bed.
 */
export function arrange(project: Project, bed: [number, number] = [256, 256], gap = 10) {
	const boxes = project.objects.map((o) => project.meshes[o.parts[0].mesh].bbox);
	const widths = boxes.map((b) => b[3] - b[0]);
	const total = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1);
	let x = bed[0] / 2 - total / 2;
	project.objects.forEach((o, i) => {
		const b = boxes[i];
		const t = o.instances[0].transform;
		t[9] = x - b[0];
		t[10] = bed[1] / 2 - (b[1] + b[4]) / 2;
		t[11] = 0 - b[2];
		x += widths[i] + gap;
	});
}
