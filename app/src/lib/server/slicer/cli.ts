// The fallback backend: a stock Bambu Studio (or OrcaSlicer) install driven through its command line,
// behind the same SlicerEngine interface as our engine, so the app slices on every catalogue model
// without printlab-slicer. The CLI has no project in memory, so this keeps the project the client
// synced and, for each call, writes what the CLI can take: complete presets (profile-book.ts), one
// STL per object instance with its transforms baked in and the filament of each, then reads back
// result.json and the file it wrote.
//
// Options used (src/libslic3r/PrintConfig.cpp CLI*ConfigDef and src/BambuStudio.cpp at the pin):
// --load-settings "machine.json;process.json", --load-filaments "f1.json;f2.json",
// --load-filament-ids "1,2" (one per input file), --curr-bed-type, --orient 1, --arrange 1,
// --allow-rotations=0|1, --slice <plate>, --outputdir, --export-3mf. result.json holds return_code,
// error_string and per-plate total_predication and filaments[].total_used_g (record_exit_reson).
//
// Limits of this backend (the engine has none of them): modifiers, negative parts, support
// painting, per-object settings, height ranges and layer height profiles cannot be passed as STL,
// so they are left out with a warning; every plate is sliced as plate 1 in bed coordinates.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSliced } from '../printer/sliced';
import { importMesh, parseStl, readZip, rewriteZip, writeStl } from '../cad/mesh';
import { PRINTER_MODELS, type ModelCode } from '$lib/shared/printers/models';
import {
	ERROR,
	PROTOCOL,
	type EngineCapability,
	type EngineInfo,
	type EngineMethods,
	type PlateImages,
	type PlateStats,
	type SliceWarning
} from '$lib/shared/slicer/protocol';
import {
	IDENTITY,
	type ConfigMap,
	type ConfigValue,
	type Project,
	type Transform
} from '$lib/shared/slicer/project';
import type { ResolvedBundle, ResolvedPreset } from '$lib/shared/slicer/profiles';
import type { SlicedPlate } from '$lib/shared/domain';
import { DIR, profileBook, type ProfileBook } from './profile-book';
import type { SlicerLocation } from './locate';
import { EngineError, type CallOptions, type SlicerEngine } from './engine-types';

export const CLI_CAPABILITIES: EngineCapability[] = [
	'mesh.put',
	'project.sync',
	'arrange',
	'orient',
	'slice',
	'slice.cancel',
	'export.gcode3mf',
	'export.thumbnails',
	'profiles.resolve',
	'profiles.list'
];

/** One run of the command line may take this long before it is stopped. */
const RUN_TIMEOUT_MS = 10 * 60_000;

// ---------------------------------------------------------------------------------------------
// Pure helpers (tested on their own)

export interface CliRun {
	/** Paths relative to the run directory. */
	machine: string;
	process: string;
	filaments: string[];
	bedType: string;
	inputs: string[];
	/** 1-based filament of each input. */
	filamentIds: number[];
	orient?: boolean;
	/** true arranges, false keeps the positions baked into the inputs, undefined leaves it to the CLI. */
	arrange?: boolean;
	allowRotations?: boolean;
	/** Plate to slice (1-based); undefined exports the arranged/oriented project without slicing. */
	slice?: number;
	output: string;
}

/** The command line for one run. Inputs come last and never start with "-". */
export function cliArgs(r: CliRun): string[] {
	const args = [
		'--load-settings',
		`${r.machine};${r.process}`,
		'--load-filaments',
		r.filaments.join(';'),
		'--curr-bed-type',
		r.bedType
	];
	if (r.inputs.length > 1 || r.filamentIds.some((f) => f !== 1))
		args.push('--load-filament-ids', r.filamentIds.join(','));
	if (r.orient) args.push('--orient', '1');
	// STL inputs are arranged unless told not to (BambuStudio.cpp: need_arrange starts true for them).
	if (r.arrange) {
		args.push('--arrange', '1');
		if (r.allowRotations === false) args.push('--allow-rotations=0');
	} else if (r.arrange === false) args.push('--arrange', '0');
	if (r.slice !== undefined) args.push('--slice', String(r.slice));
	args.push('--outputdir', 'out', '--export-3mf', r.output);
	for (const input of r.inputs) {
		if (input.startsWith('-')) throw new Error(`Input ${input} looks like an option.`);
		args.push(input);
	}
	return args;
}

export interface CliResult {
	ok: boolean;
	error: string;
	/** grams: by 1-based filament number, for the filaments the plate uses. */
	plates: { id: number; seconds: number; grams: Map<number, number>; warning: string }[];
}

/** result.json as the CLI writes it (BambuStudio.cpp record_exit_reson). */
export function parseResult(json: unknown): CliResult {
	const r = (json ?? {}) as {
		return_code?: number;
		error_string?: string;
		sliced_plates?: {
			id?: number;
			total_predication?: number;
			warning_message?: string;
			filaments?: { id?: number; total_used_g?: number }[];
		}[];
	};
	return {
		ok: r.return_code === 0,
		error: r.error_string ?? '',
		plates: (r.sliced_plates ?? []).map((p, i) => ({
			id: p.id || i + 1,
			seconds: Math.round(p.total_predication ?? 0),
			// Only the filaments used, each with its 1-based number (BambuStudio.cpp: filament_info.id = extruder + 1).
			grams: new Map(
				(p.filaments ?? []).map((f, j) => [
					f.id || j + 1,
					Math.round((f.total_used_g ?? 0) * 100) / 100
				])
			),
			warning: p.warning_message ?? ''
		}))
	};
}

function transformAttr(tag: string): Transform {
	const t = tag.match(/\btransform="([^"]*)"/)?.[1];
	const nums = t ? t.trim().split(/\s+/).map(Number) : [];
	return (nums.length === 12 && nums.every(Number.isFinite) ? nums : [...IDENTITY]) as Transform;
}

/**
 * Where each build item's geometry ends up, in order (one per object instance). Bambu Studio writes
 * vertices untransformed, the volume matrix on the object's component and the instance matrix on the
 * build item (bbs_3mf.cpp _add_mesh_to_object_stream, _add_build_to_model_stream), and its auto-orient
 * turns the volumes rather than the instance (ModelObject::rotate), so both are needed: the object's
 * first component, then the item.
 */
export function readPlacements(buf: Buffer): Transform[] {
	const model = readZip(buf, (name) => (name === '3D/3dmodel.model' ? 'all' : false)).get(
		'3D/3dmodel.model'
	);
	if (!model) throw new Error('The 3MF has no 3D/3dmodel.model.');
	const text = model.toString('utf8');
	const components = new Map<string, Transform>();
	for (const m of text.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
		const id = m[1].match(/\bid="([^"]*)"/)?.[1];
		const component = m[2].match(/<component\b[^>]*>/)?.[0];
		if (id && component) components.set(id, transformAttr(component));
	}
	const build = text.match(/<build\b[^>]*>([\s\S]*?)<\/build>/)?.[1] ?? '';
	return [...build.matchAll(/<item\b[^>]*>/g)].map((m) => {
		const id = m[0].match(/\bobjectid="([^"]*)"/)?.[1] ?? '';
		return compose(components.get(id) ?? [...IDENTITY], transformAttr(m[0]));
	});
}

/** A translation as a transform. */
export const move = (x: number, y: number, z = 0): Transform => [
	1,
	0,
	0,
	0,
	1,
	0,
	0,
	0,
	1,
	x,
	y,
	z
];

/** The printable area's bounds [minX, minY, maxX, maxY] from printable_area ("0x0", "256x0", …). */
export function bedBounds(
	printableArea: ConfigValue | undefined
): [number, number, number, number] {
	const points = (Array.isArray(printableArea) ? printableArea : [])
		.map((p) => p.split('x').map(Number))
		.filter((p) => p.length === 2 && p.every(Number.isFinite));
	if (!points.length) return [0, 0, 256, 256];
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * A plate's origin in project coordinates. Bambu Studio lays plates out in a grid with a fifth of a
 * plate between them (PartPlate.hpp compute_colum_count, PartPlate.cpp LOGICAL_PART_PLATE_GAP); the
 * engine does the same (facade/upstream/model_io.cpp plate_origin), so both backends agree.
 */
export function plateOrigin(
	printableArea: ConfigValue | undefined,
	plates: number,
	index: number
): [number, number] {
	const [minX, minY, maxX, maxY] = bedBounds(printableArea);
	const value = Math.sqrt(Math.max(1, plates));
	const round = Math.round(value);
	const cols = value > round ? round + 1 : round;
	const i = Math.max(0, index - 1);
	return [(i % cols) * (maxX - minX) * 1.2, 0 - Math.floor(i / cols) * (maxY - minY) * 1.2];
}

/**
 * a·b for 3MF transforms (row-vector convention: a point p maps to p·M, so `compose(a, b)` applies a
 * first, then b). Equivalent to B×A in column-vector form.
 */
export function compose(a: Transform, b: Transform): Transform {
	const m = (t: Transform) => [
		[t[0], t[1], t[2], 0],
		[t[3], t[4], t[5], 0],
		[t[6], t[7], t[8], 0],
		[t[9], t[10], t[11], 1]
	];
	const A = m(a);
	const B = m(b);
	const out: number[] = [];
	for (let r = 0; r < 4; r++)
		for (let c = 0; c < 3; c++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += A[r][k] * B[k][c];
			out.push(s);
		}
	return out as Transform;
}

/** Applies a transform to a triangle soup (x y z × 3 per triangle); mirrored transforms keep facets outward. */
export function bake(soup: Float32Array, t: Transform): Float32Array {
	const out = new Float32Array(soup.length);
	for (let i = 0; i < soup.length; i += 3) {
		const x = soup[i];
		const y = soup[i + 1];
		const z = soup[i + 2];
		out[i] = x * t[0] + y * t[3] + z * t[6] + t[9];
		out[i + 1] = x * t[1] + y * t[4] + z * t[7] + t[10];
		out[i + 2] = x * t[2] + y * t[5] + z * t[8] + t[11];
	}
	const det =
		t[0] * (t[4] * t[8] - t[5] * t[7]) -
		t[1] * (t[3] * t[8] - t[5] * t[6]) +
		t[2] * (t[3] * t[7] - t[4] * t[6]);
	if (det < 0)
		for (let i = 0; i < out.length; i += 9)
			for (let k = 0; k < 3; k++) {
				const a = out[i + 3 + k];
				out[i + 3 + k] = out[i + 6 + k];
				out[i + 6 + k] = a;
			}
	return out;
}

/** A preset as the CLI loads it: complete, with name, type and from (BambuStudio.cpp load_config_file). */
export function cliPreset(p: ResolvedPreset, extra: ConfigMap = {}) {
	return { ...p.config, ...extra, name: p.name, type: DIR[p.kind], from: 'system' };
}

/**
 * Where a project-level override goes: the preset that already has the key (process first), else the
 * process. Per-filament arrays go to each filament by index.
 */
export function splitOverrides(bundle: ResolvedBundle, overrides: ConfigMap) {
	const printer: ConfigMap = {};
	const process: ConfigMap = {};
	const filaments: ConfigMap[] = bundle.filaments.map(() => ({}));
	for (const [key, value] of Object.entries(overrides)) {
		if (key in bundle.process.config) process[key] = value;
		else if (key in bundle.printer.config) printer[key] = value;
		else if (bundle.filaments.some((f) => key in f.config))
			bundle.filaments.forEach((_, i) => {
				filaments[i][key] = Array.isArray(value) ? [value[i] ?? value[0] ?? ''] : [value];
			});
		else process[key] = value;
	}
	return { printer, process, filaments };
}

/**
 * Fills in what the command line leaves out: the printer model code in slice_info.config (it writes
 * it blank) and plate pictures (it cannot render without a GPU).
 */
export function finishSliced(
	file: Buffer,
	modelId: string,
	thumbnails: Map<number, Buffer>
): Buffer {
	const entries = readZip(file, (name) =>
		name === 'Metadata/slice_info.config' || /^Metadata\/plate_\d+\.(gcode\.md5|png)$/.test(name)
			? 'all'
			: false
	);
	const changes = new Map<string, Buffer>();
	const info = entries.get('Metadata/slice_info.config');
	if (info)
		changes.set(
			'Metadata/slice_info.config',
			Buffer.from(
				info
					.toString('utf8')
					.replace(
						/<metadata key="printer_model_id" value="[^"]*"\/>/g,
						`<metadata key="printer_model_id" value="${modelId}"/>`
					)
			)
		);
	for (const name of entries.keys()) {
		const m = name.match(/^Metadata\/plate_(\d+)\.gcode\.md5$/);
		const png = m && thumbnails.get(Number(m[1]));
		if (!png) continue;
		for (const pic of [`plate_${m[1]}.png`, `plate_no_light_${m[1]}.png`])
			if (!entries.has(`Metadata/${pic}`)) changes.set(`Metadata/${pic}`, png);
	}
	// Everything else, above all the large G-code, is copied as it is.
	return rewriteZip(file, changes);
}

/** The catalogue model a printer preset is for (printer_model → model code). */
export function modelOfPrinter(printerModel: string): ModelCode | null {
	return (
		(Object.values(PRINTER_MODELS).find((m) => m.name === printerModel)?.code as ModelCode) ?? null
	);
}

// ---------------------------------------------------------------------------------------------
// The backend

type SceneObject = Project['objects'][number];
type Instance = SceneObject['instances'][number];
/** An instance for the CLI and the origin of the plate it is on. */
type Row = { object: SceneObject; instance: Instance; plate: number; origin: [number, number] };

interface CliProject {
	project: Project | null;
	bundle: ResolvedBundle | null;
	revision: number;
	sliced: Map<number, { file: string; stats: PlateStats }>;
	dir: string;
}

type Ready = CliProject & { project: Project; bundle: ResolvedBundle };

export interface CliEngineOptions {
	location: SlicerLocation;
	/** Scratch files; created if missing. */
	workDir: string;
	/** For tests: run the "CLI" through another program (e.g. node with a script). */
	command?: string;
	commandArgs?: string[];
	env?: Record<string, string | undefined>;
}

/** "02.08.02.61" from an install path like ~/.local/opt/bambu-studio-02.08.02.61/AppRun. */
export function versionFromPath(p: string): string | null {
	return p.match(/(?:bambu-studio|orca-slicer)[-_]v?(\d+(?:\.\d+)+)/i)?.[1] ?? null;
}

export class CliEngine implements SlicerEngine {
	readonly info: EngineInfo;
	private projects = new Map<string, CliProject>();
	private meshes = new Map<string, string>();
	private nextProject = 1;
	private closed = false;
	/** Runs of the command line so far (tests count them). */
	runs = 0;

	constructor(private readonly o: CliEngineOptions) {
		const orca = o.location.kind === 'orca-slicer-cli';
		const version = versionFromPath(o.location.path) ?? 'unknown';
		const resources = o.location.resourcesDir;
		const book = resources ? this.bookOrNull(resources) : null;
		this.info = {
			engine: orca ? 'orca-slicer-cli' : 'bambu-studio-cli',
			version,
			protocol: { ...PROTOCOL },
			upstream: {
				name: orca ? 'OrcaSlicer' : 'BambuStudio',
				tag: version === 'unknown' ? 'unknown' : `v${version}`,
				commit: null
			},
			patchQueue: null,
			capabilities: [...CLI_CAPABILITIES],
			profiles:
				resources && book
					? { dir: path.join(resources, 'profiles', 'BBL'), vendorVersion: book.version }
					: null
		};
		fs.mkdirSync(o.workDir, { recursive: true });
	}

	private bookOrNull(resources: string): ProfileBook | null {
		return fs.existsSync(path.join(resources, 'profiles', 'BBL')) ? profileBook(resources) : null;
	}

	private book(): ProfileBook {
		const resources = this.o.location.resourcesDir;
		const book = resources ? this.bookOrNull(resources) : null;
		if (!book)
			throw new EngineError(
				ERROR.PRESET_NOT_FOUND,
				'The slicer’s profiles were not found next to it. Reinstall Bambu Studio.'
			);
		return book;
	}

	has(cap: EngineCapability) {
		return this.info.capabilities.includes(cap);
	}

	async call<M extends keyof EngineMethods>(
		method: M,
		params: EngineMethods[M]['params'],
		opts: CallOptions = {}
	): Promise<EngineMethods[M]['result']> {
		if (this.closed) throw new EngineError(ERROR.INTERNAL, 'The slicer has been closed.');
		if (opts.signal?.aborted) throw new EngineError(ERROR.CANCELLED, 'Cancelled.');
		const handler = (this.handlers as Record<string, (p: unknown, o: CallOptions) => unknown>)[
			method
		];
		if (!handler)
			throw new EngineError(
				ERROR.CAPABILITY_MISSING,
				`The Bambu Studio command line cannot do that (${method}).`,
				{ message: 'Install Print Lab Slicer to use this.', key: method }
			);
		return (await handler.call(this, params, opts)) as EngineMethods[M]['result'];
	}

	async close() {
		this.closed = true;
		for (const p of this.projects.values()) fs.rmSync(p.dir, { recursive: true, force: true });
		this.projects.clear();
	}

	private project(id: string): CliProject {
		const p = this.projects.get(id);
		if (!p) throw new EngineError(ERROR.PROJECT_NOT_FOUND, 'That slicer project is not open.');
		return p;
	}

	private ready(id: string) {
		const p = this.project(id);
		if (!p.project || !p.bundle)
			throw new EngineError(ERROR.INVALID_REQUEST, 'The project has not been synced yet.');
		return p as Ready;
	}

	private handlers: {
		[M in keyof EngineMethods]?: (
			p: EngineMethods[M]['params'],
			o: CallOptions
		) => Promise<EngineMethods[M]['result']> | EngineMethods[M]['result'];
	} = {
		'engine.hello': () => this.info,
		'engine.ping': () => ({ ok: true }),
		'engine.shutdown': async () => {
			await this.close();
			return { ok: true };
		},
		'mesh.put': (p) => {
			if (p.format === 'step')
				throw new EngineError(
					ERROR.UNSUPPORTED_FORMAT,
					'STEP files need Print Lab Slicer; export an STL or 3MF instead.'
				);
			let soup: Float32Array;
			try {
				soup = importMesh(fs.readFileSync(p.path), p.format);
			} catch (e) {
				throw new EngineError(ERROR.FILE_READ, 'That mesh could not be read.', {
					message: 'That mesh could not be read.',
					detail: (e as Error).message
				});
			}
			this.meshes.set(p.meshId, p.path);
			return {
				meshId: p.meshId,
				triangles: soup.length / 9,
				bbox: bboxOf(soup),
				repaired: { edgesFixed: 0, facetsRemoved: 0, facetsReversed: 0 }
			};
		},
		'mesh.drop': (p) => {
			for (const id of p.meshIds) this.meshes.delete(id);
			return { ok: true };
		},
		'project.create': () => {
			// Unique on disk too: another CliEngine may share the work folder (openSlicer retries).
			const projectId = `cli-${this.nextProject++}-${crypto.randomBytes(4).toString('hex')}`;
			const dir = path.join(this.o.workDir, projectId);
			fs.mkdirSync(dir, { recursive: true });
			this.projects.set(projectId, {
				project: null,
				bundle: null,
				revision: 0,
				sliced: new Map(),
				dir
			});
			return { projectId };
		},
		'project.sync': (p) => {
			const cp = this.project(p.projectId);
			cp.project = structuredClone(p.project);
			cp.bundle = structuredClone(p.presets);
			cp.sliced.clear();
			cp.revision++;
			const errors = [];
			for (const o of cp.project.objects)
				for (const part of o.parts)
					if (!this.meshPath(cp.project, part.mesh))
						errors.push({
							key: 'mesh',
							message: `The mesh of ${part.name} is missing.`,
							objectId: o.id
						});
			return { revision: cp.revision, errors };
		},
		'project.close': (p) => {
			const cp = this.projects.get(p.projectId);
			if (cp) fs.rmSync(cp.dir, { recursive: true, force: true });
			this.projects.delete(p.projectId);
			return { ok: true };
		},
		'profiles.list': (p) => ({ presets: this.book().list(p.kind) }),
		'profiles.resolve': (p) => {
			const book = this.book();
			for (const ref of [p.selection.printer, p.selection.process, ...p.selection.filaments])
				if (ref.source !== 'system' || !book.has(ref.kind, ref.name))
					throw new EngineError(
						ERROR.PRESET_NOT_FOUND,
						ref.source === 'system'
							? `Bambu Studio has no ${ref.kind} preset “${ref.name}”.`
							: 'The command line only knows Bambu Studio’s own presets.',
						{ message: 'Pick another preset.', key: ref.name }
					);
			return book.bundle(p.selection, this.info.upstream.tag);
		},
		orient: async (p, o) => {
			const cp = this.ready(p.projectId);
			const rows = cp.project.objects
				.filter((ob) => p.objectIds.includes(ob.id) && ob.instances.length)
				.map((ob) => this.row(cp, ob, ob.instances[0]));
			if (!rows.length) return { objects: [] };
			o.onProgress?.({ stage: 'orienting', percent: 10, message: 'Finding the best way up…' });
			// Positions stay (--arrange 0): only the way up changes, as the engine's orient does.
			const run = await this.runPlaced(cp, rows, { orient: true, arrange: false }, o);
			return {
				objects: rows.map((r, i) => {
					// The CLI centres the turned object on the bed origin; put it back where it stood.
					const before = centreOf(run.baked[i]);
					const after = centreOf(bake(run.baked[i], run.moves[i]));
					const back = move(before[0] - after[0], before[1] - after[1]);
					return { objectId: r.object.id, transform: this.placed(r, compose(run.moves[i], back)) };
				})
			};
		},
		arrange: async (p, o) => {
			const cp = this.ready(p.projectId);
			const plates =
				p.plate === 'all'
					? cp.project.plates.filter((pl) => !pl.locked)
					: cp.project.plates.filter((pl) => pl.index === p.plate);
			const out: EngineMethods['arrange']['result']['instances'] = [];
			const [minX, minY, maxX, maxY] = bedBounds(cp.bundle.printer.config.printable_area);
			for (const plate of plates) {
				const rows = this.plateRows(cp, plate.index).rows;
				if (!rows.length) continue;
				o.onProgress?.({ stage: 'arranging', percent: 10, message: 'Arranging the plate…' });
				const run = await this.runPlaced(
					cp,
					rows,
					{ arrange: true, allowRotations: p.allowRotation },
					o
				);
				rows.forEach((r, i) => {
					// What did not fit went to plates the CLI made up; the engine says the same.
					const b = bboxOf(bake(run.baked[i], run.moves[i]));
					if (b[0] < minX - 0.5 || b[1] < minY - 0.5 || b[3] > maxX + 0.5 || b[4] > maxY + 0.5)
						throw new EngineError(ERROR.OUTSIDE_PLATE, 'Some objects do not fit on the plate.', {
							message: 'Some objects do not fit on the plate.',
							objectId: r.object.id
						});
					out.push({
						objectId: r.object.id,
						instanceId: r.instance.id,
						plate: plate.index,
						transform: this.placed(r, run.moves[i])
					});
				});
			}
			return { instances: out };
		},
		slice: async (p, o) => {
			const cp = this.ready(p.projectId);
			const { rows, warnings } = this.plateRows(cp, p.plate);
			if (!rows.length)
				throw new EngineError(ERROR.NOTHING_TO_SLICE, 'There is nothing on this plate to slice.');
			o.onProgress?.({ stage: 'slicing', percent: 5, message: 'Slicing in Bambu Studio…' });
			// Sliced where the objects stand (--arrange 0), on its own plate at the bed origin.
			const run = await this.run(cp, rows, { slice: 1, arrange: false }, o, p.plate);
			const target = path.join(cp.dir, `plate_${p.plate}.gcode.3mf`);
			fs.copyFileSync(run.output, target);
			const file = readSliced(fs.readFileSync(target));
			const plate = run.result.plates[0];
			const read = file.plates[0];
			const stats: PlateStats = {
				plate: p.plate,
				seconds: plate?.seconds ?? (read?.minutes ?? 0) * 60,
				layers: read?.layers ?? 0,
				filaments: (read?.filaments ?? []).map((f, i) => ({
					index: f.id || i + 1,
					grams: plate?.grams.get(f.id || i + 1) ?? f.grams,
					meters: f.meters
				})),
				objects: [],
				warnings: [
					...warnings,
					...(plate?.warning ? [{ code: 'SLICER', message: plate.warning, plate: p.plate }] : [])
				]
			};
			cp.sliced.set(p.plate, { file: target, stats });
			o.onProgress?.({ stage: 'gcode', percent: 100, message: 'Sliced.' });
			return stats;
		},
		'export.gcode3mf': async (p) => {
			const cp = this.ready(p.projectId);
			const wanted = p.plates === 'all' ? [...cp.sliced.keys()] : p.plates;
			if (wanted.length !== 1)
				throw new EngineError(
					ERROR.EXPORT_FAILED,
					'The Bambu Studio command line exports one plate per file.'
				);
			const sliced = cp.sliced.get(wanted[0]);
			if (!sliced) throw new EngineError(ERROR.EXPORT_FAILED, 'Slice the plate first.');
			const thumbnails = new Map<number, Buffer>();
			if (p.thumbnails !== 'engine')
				for (const t of p.thumbnails as PlateImages[])
					if (t.plate === wanted[0] && fs.existsSync(t.thumbnail))
						thumbnails.set(1, fs.readFileSync(t.thumbnail));
			const model = modelOfPrinter(String(cp.bundle.printer.config.printer_model ?? ''));
			const data = finishSliced(
				fs.readFileSync(sliced.file),
				this.modelId(cp.project, model),
				thumbnails
			);
			fs.writeFileSync(p.path, data);
			const plates: SlicedPlate[] = readSliced(data).plates;
			return { path: p.path, plates };
		}
	};

	/**
	 * The printer model code for the file: the one the client asked for in meta.extras.printer_model_id
	 * (the H2C has two codes), else the catalogue model of the printer preset.
	 */
	private modelId(project: Project, model: ModelCode | null) {
		const explicit = project.meta.extras?.printer_model_id;
		if (explicit && PRINTER_MODELS[explicit as ModelCode]) return explicit;
		return model ?? '';
	}

	private meshPath(project: Project, meshId: string): string | null {
		const put = this.meshes.get(meshId);
		if (put) return put;
		const ref = project.meshes[meshId];
		return ref?.storage.kind === 'file' ? ref.storage.path : null;
	}

	/** What the CLI can print from a plate: model parts per instance, and warnings for the rest. */
	private plateRows(cp: Ready, plateIndex: number) {
		const { project } = cp;
		const plate = project.plates.find((pl) => pl.index === plateIndex);
		if (!plate) throw new EngineError(ERROR.INVALID_PARAMS, `There is no plate ${plateIndex}.`);
		const warnings: SliceWarning[] = [];
		const rows: Row[] = [];
		for (const ref of plate.instances) {
			const object = project.objects.find((ob) => ob.id === ref.objectId);
			const instance = object?.instances.find((i) => i.id === ref.instanceId);
			if (!object || !instance || !object.printable || !instance.printable) continue;
			const skipped = object.parts.filter((pt) => pt.type !== 'model');
			if (skipped.length)
				warnings.push({
					code: 'CLI_PART_IGNORED',
					message: `${object.name}: modifiers and negative parts need Print Lab Slicer and were left out.`,
					objectId: object.id,
					plate: plateIndex
				});
			if (
				Object.keys(object.config).length ||
				object.heightRanges.length ||
				object.layerHeightProfile?.length ||
				object.parts.some((pt) => Object.keys(pt.config).length || pt.paint)
			)
				warnings.push({
					code: 'CLI_SETTINGS_IGNORED',
					message: `${object.name}: per-object settings and painting need Print Lab Slicer and were left out.`,
					objectId: object.id,
					plate: plateIndex
				});
			rows.push(this.row(cp, object, instance, plateIndex));
		}
		return { rows, warnings };
	}

	/** An instance to hand the CLI, with the origin of its plate (it slices every plate at the bed origin). */
	private row(cp: Ready, object: SceneObject, instance: Instance, plate?: number): Row {
		plate ??=
			cp.project.plates.find((pl) =>
				pl.instances.some((i) => i.objectId === object.id && i.instanceId === instance.id)
			)?.index ?? 1;
		const origin = plateOrigin(
			cp.bundle.printer.config.printable_area,
			cp.project.plates.length,
			plate
		);
		return { object, instance, plate, origin };
	}

	/** An instance transform back in project coordinates after the CLI moved its baked mesh by `m`. */
	private placed(r: Row, m: Transform): Transform {
		const [x, y] = r.origin;
		return compose(compose(compose(r.instance.transform, move(-x, -y)), m), move(x, y));
	}

	/**
	 * Runs the CLI without slicing and returns, for each row, how it moved the mesh it was given. The
	 * CLI centres a loaded mesh in its volume (ModelVolume::center_geometry_after_creation), so the
	 * move is: back from that centre, then the placement it wrote.
	 */
	private async runPlaced(
		cp: Ready,
		rows: Row[],
		what: { orient?: boolean; arrange?: boolean; allowRotations?: boolean },
		o: CallOptions
	): Promise<{ baked: Float32Array[]; moves: Transform[] }> {
		const run = await this.run(cp, rows, what, o, rows[0].plate);
		let placements: Transform[];
		try {
			placements = readPlacements(fs.readFileSync(run.output));
		} finally {
			fs.rmSync(run.output, { force: true });
		}
		if (placements.length !== rows.length)
			throw new EngineError(
				ERROR.UPSTREAM_EXCEPTION,
				'The slicer returned a different number of objects than it was given.'
			);
		return {
			baked: run.baked,
			moves: placements.map((t, i) => {
				const [x, y, z] = centreOf(run.baked[i]);
				return compose(move(-x, -y, -z), t);
			})
		};
	}

	/** One run of the CLI on `rows`, each baked into bed coordinates of its plate; `plateIndex` gives the settings. */
	private async run(
		cp: Ready,
		rows: Row[],
		what: { orient?: boolean; arrange?: boolean; allowRotations?: boolean; slice?: number },
		o: CallOptions,
		plateIndex: number
	): Promise<{ output: string; result: CliResult; log: string; baked: Float32Array[] }> {
		const dir = fs.mkdtempSync(path.join(cp.dir, 'run-'));
		try {
			const { project, bundle } = cp;
			const plate = project.plates.find((pl) => pl.index === plateIndex);
			const split = splitOverrides(bundle, { ...project.projectConfig, ...(plate?.config ?? {}) });
			const write = (file: string, data: unknown) =>
				fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
			write('machine.json', cliPreset(bundle.printer, split.printer));
			write('process.json', cliPreset(bundle.process, split.process));
			const filamentFiles = bundle.filaments.map((f, i) => {
				const slot = project.filaments.find((s) => s.index === i + 1);
				const colour: ConfigMap =
					slot?.color && /^#?[0-9a-f]{6}/i.test(slot.color)
						? { filament_colour: [`#${slot.color.replace('#', '').slice(0, 6).toUpperCase()}`] }
						: {};
				const file = `filament_${i + 1}.json`;
				write(file, cliPreset(f, { ...split.filaments[i], ...colour }));
				return file;
			});
			const inputs: string[] = [];
			const filamentIds: number[] = [];
			const baked: Float32Array[] = [];
			rows.forEach((r, i) => {
				const parts = r.object.parts.filter((pt) => pt.type === 'model');
				const soups = parts.map((pt) => {
					const file = this.meshPath(project, pt.mesh);
					if (!file)
						throw new EngineError(ERROR.MESH_NOT_FOUND, `The mesh of ${pt.name} is missing.`);
					const soup = file.toLowerCase().endsWith('.stl')
						? parseStl(fs.readFileSync(file))
						: importMesh(
								fs.readFileSync(file),
								file.toLowerCase().endsWith('.obj') ? 'obj' : '3mf'
							);
					return bake(
						soup,
						compose(compose(pt.transform, r.instance.transform), move(-r.origin[0], -r.origin[1]))
					);
				});
				const all = new Float32Array(soups.reduce((a, s) => a + s.length, 0));
				let at = 0;
				for (const s of soups) {
					all.set(s, at);
					at += s.length;
				}
				baked.push(all);
				const name = `object ${i + 1}.stl`;
				fs.writeFileSync(path.join(dir, name), writeStl(all, r.object.name.slice(0, 60)));
				inputs.push(name);
				// The object's filament: its first part's, else the object's extruder setting.
				const f = parts[0]?.filament ?? Number(r.object.config.extruder);
				filamentIds.push(Number.isInteger(f) && f >= 1 && f <= filamentFiles.length ? f : 1);
			});
			fs.mkdirSync(path.join(dir, 'out'));
			const args = cliArgs({
				machine: 'machine.json',
				process: 'process.json',
				filaments: filamentFiles,
				bedType:
					plate?.bedType ??
					(typeof project.projectConfig.curr_bed_type === 'string'
						? project.projectConfig.curr_bed_type
						: 'Textured PEI Plate'),
				inputs,
				filamentIds,
				...what,
				output: 'result.3mf'
			});
			const log = await this.exec(args, dir, o.signal);
			const resultFile = path.join(dir, 'out', 'result.json');
			const result = fs.existsSync(resultFile)
				? parseResult(JSON.parse(fs.readFileSync(resultFile, 'utf8')))
				: { ok: false, error: '', plates: [] };
			const output = path.join(dir, 'out', 'result.3mf');
			if (!result.ok || !fs.existsSync(output))
				throw new EngineError(
					what.slice !== undefined ? ERROR.SLICE_FAILED : ERROR.UPSTREAM_EXCEPTION,
					`Bambu Studio could not ${what.slice !== undefined ? 'slice this plate' : 'do that'}: ${result.error || lastError(log) || 'no result'}.`,
					{ message: result.error || 'The slicer failed.', detail: lastError(log) }
				);
			// Keep the output past the run directory's removal.
			const kept = path.join(cp.dir, `out-${crypto.randomBytes(4).toString('hex')}.3mf`);
			fs.renameSync(output, kept);
			return { output: kept, result, log, baked };
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	private exec(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
		this.runs++;
		const command = this.o.command ?? this.o.location.path;
		const all = [...(this.o.commandArgs ?? []), ...args];
		return new Promise((resolve, reject) => {
			const child = spawn(command, all, {
				cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, ...this.o.env },
				windowsHide: true
			});
			let log = '';
			const keep = (b: Buffer) => {
				log = (log + b.toString()).slice(-20_000);
			};
			child.stdout.on('data', keep);
			child.stderr.on('data', keep);
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill('SIGKILL');
			}, RUN_TIMEOUT_MS);
			const abort = () => child.kill('SIGKILL');
			signal?.addEventListener('abort', abort, { once: true });
			child.on('error', (e) => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', abort);
				reject(new EngineError(ERROR.INTERNAL, `Bambu Studio could not be started: ${e.message}`));
			});
			child.on('close', () => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', abort);
				if (signal?.aborted) reject(new EngineError(ERROR.CANCELLED, 'Slicing was cancelled.'));
				else if (timedOut)
					reject(new EngineError(ERROR.INTERNAL, 'The slicer took too long and was stopped.'));
				else resolve(log);
			});
		});
	}
}

function bboxOf(soup: Float32Array) {
	const b: [number, number, number, number, number, number] = [
		Infinity,
		Infinity,
		Infinity,
		-Infinity,
		-Infinity,
		-Infinity
	];
	for (let i = 0; i < soup.length; i += 3)
		for (let k = 0; k < 3; k++) {
			b[k] = Math.min(b[k], soup[i + k]);
			b[k + 3] = Math.max(b[k + 3], soup[i + k]);
		}
	return soup.length ? b : ([0, 0, 0, 0, 0, 0] as typeof b);
}

function centreOf(soup: Float32Array): [number, number, number] {
	const b = bboxOf(soup);
	return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
}

function lastError(log: string) {
	return (
		log
			.split('\n')
			.reverse()
			.find((l) => /error/i.test(l))
			?.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)*/, '')
			.slice(0, 200) ?? ''
	);
}
