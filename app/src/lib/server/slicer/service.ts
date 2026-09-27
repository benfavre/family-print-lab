// Slicing a model version for a job, whichever backend is installed: Print Lab Slicer (our engine) or
// the stock Bambu Studio command line, both behind SlicerEngine (engine.ts openSlicer). One flow for
// both: pick the presets closest to the job's settings, resolve them (slicer-profiles when it is
// installed, else the backend itself), build a one-object project, orient and arrange it as Bambu
// Studio's "auto" buttons do, slice plate 1 and export a printable .gcode.3mf with the model's picture.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../validation';
import { PRINTER_MODELS } from '$lib/shared/printers/models';
import { ERROR, type Progress } from '$lib/shared/slicer/protocol';
import { IDENTITY, emptyProject, type ConfigMap, type Project } from '$lib/shared/slicer/project';
import type { ProfileService, ResolvedBundle } from '$lib/shared/slicer/profiles';
import { EngineError, openSlicer, slicerWorkDir, type SlicerEngine } from './engine';
import {
	bedTypeFor,
	chooseProfiles,
	machinePreset,
	profileBook,
	selectionOf,
	type SliceChoice,
	type SliceSettings
} from './profile-book';

export type { SliceChoice, SliceSettings };

/** What every backend must offer for a job to slice. */
const NEEDED = ['mesh.put', 'project.sync', 'slice', 'export.gcode3mf'] as const;

let settings: {
	env?: Record<string, string | undefined>;
	profiles: () => ProfileService | undefined;
} = { profiles: () => undefined };
/**
 * Set by the slicer-engine module: the runtime's environment (where the slicer is) and slicer-profiles'
 * service, when that package is installed.
 */
export function configureSlicer(o: {
	env?: Record<string, string | undefined>;
	profiles?: () => ProfileService | undefined;
}) {
	settings = { env: o.env, profiles: o.profiles ?? (() => undefined) };
}

export interface SliceRequest {
	stl: Buffer;
	name: string;
	settings: SliceSettings;
	/** A PNG of the part: the plate picture the printer shows. */
	thumbnail?: Buffer | null;
	signal?: AbortSignal;
	onStage?: (text: string) => void;
	env?: Record<string, string | undefined>;
	/** For tests: a backend to use instead of openSlicer(). */
	engine?: SlicerEngine;
}

export interface SliceOutcome {
	data: Buffer;
	choice: SliceChoice;
	minutes: number;
	grams: number;
	/** Which backend sliced it. */
	backend: SlicerEngine['info']['engine'];
	warnings: string[];
}

/** Plain words for the task list from an engine's progress. */
function stageText(p: Progress): string {
	return p.message || `${p.stage[0].toUpperCase()}${p.stage.slice(1)}…`;
}

/** Engine errors carry plain words already; they become 422s the task shows as they are. */
function friendly(e: unknown): Error {
	if (e instanceof EngineError)
		return e.code === ERROR.CANCELLED ? new Error('Stopped') : new AppError(422, e.message);
	return e as Error;
}

/** Job overrides on top of the presets: infill, supports and the spool's colour. */
export function jobOverrides(s: SliceSettings): { process: ConfigMap; filaments: ConfigMap[] } {
	const process: ConfigMap = {};
	if (s.infill !== null && s.infill >= 0 && s.infill <= 100)
		process.sparse_infill_density = `${Math.round(s.infill)}%`;
	process.enable_support = s.supports === 'None' ? '0' : '1';
	if (s.supports !== 'None')
		process.support_type = s.supports === 'Tree' ? 'tree(auto)' : 'normal(auto)';
	const filament: ConfigMap = {};
	if (s.color && /^#?[0-9a-f]{6}$/i.test(s.color))
		filament.filament_colour = [`#${s.color.replace('#', '').toUpperCase()}`];
	return { process, filaments: [filament] };
}

/** Overrides applied to a resolved bundle (what slicer-profiles' bundle() does, for the fallback). */
export function applyOverrides(
	bundle: ResolvedBundle,
	o: { process?: ConfigMap; filaments?: ConfigMap[]; printer?: ConfigMap }
): ResolvedBundle {
	const set = (p: ResolvedBundle['process'], extra: ConfigMap = {}) => ({
		...p,
		config: { ...p.config, ...extra },
		origin: { ...p.origin, ...Object.fromEntries(Object.keys(extra).map((k) => [k, 'job'])) }
	});
	// The combined config keeps what the backend resolved (upstream's full_config for the engine) and
	// takes the overrides on top: printer and process keys as they are, filament keys at their index.
	const full: ConfigMap = { ...bundle.full, ...o.printer, ...o.process };
	o.filaments?.forEach((f, i) => {
		for (const [key, value] of Object.entries(f)) {
			const current = full[key];
			const list = Array.isArray(current) ? [...current] : bundle.filaments.map(() => '');
			list[i] = Array.isArray(value) ? (value[0] ?? '') : value;
			full[key] = list;
		}
	});
	return {
		...bundle,
		printer: set(bundle.printer, o.printer),
		process: set(bundle.process, o.process),
		filaments: bundle.filaments.map((f, i) => set(f, o.filaments?.[i])),
		full
	};
}

/** The presets for a job: from the backend's own profiles (they match its version), else slicer-profiles. */
function choose(engine: SlicerEngine, s: SliceSettings, profiles: ProfileService | undefined) {
	const dir = engine.info.profiles?.dir;
	if (dir && fs.existsSync(dir))
		return chooseProfiles(profileBook(path.dirname(path.dirname(dir))), s);
	if (profiles) {
		const pick = profiles.defaults(s.model, s.nozzle || '0.4', s.material || 'PLA');
		return {
			machine: pick.printer.name,
			process: pick.process.name,
			filament: pick.filaments[0]?.name ?? '',
			bedType: bedTypeFor(s.plate)
		};
	}
	throw new AppError(
		503,
		`The slicer has no profiles for ${machinePreset(s.model, s.nozzle)}. Reinstall it (see Integrations).`
	);
}

/** Slices one STL for a printer model with a job's settings. */
export async function sliceModel(req: SliceRequest): Promise<SliceOutcome> {
	const engine = req.engine ?? (await openSlicer(req.env ?? settings.env));
	if (!engine)
		throw new AppError(503, 'No slicer is installed. See Integrations to add Bambu Studio.');
	const missing = NEEDED.filter((c) => !engine.has(c));
	if (missing.length)
		throw new AppError(
			503,
			`This slicer cannot slice jobs yet (${missing.join(', ')}). Update Print Lab Slicer.`
		);
	const s = req.settings;
	const printer = PRINTER_MODELS[s.model];
	const profiles = settings.profiles();
	const stage = req.onStage ?? (() => {});
	const opts = {
		signal: req.signal,
		onProgress: (p: Progress) => stage(stageText(p))
	};

	stage(
		engine.info.engine === 'printlab-slicer'
			? 'Choosing profiles…'
			: 'Choosing Bambu Studio profiles…'
	);
	const choice = choose(engine, s, profiles);
	const selection = selectionOf(choice);
	const overrides = jobOverrides(s);

	const dir = path.join(slicerWorkDir(), `job-${crypto.randomBytes(6).toString('hex')}`);
	fs.mkdirSync(dir, { recursive: true });
	let projectId: string | null = null;
	const meshId = crypto.createHash('sha256').update(req.stl).digest('hex');
	try {
		let bundle: ResolvedBundle;
		if (profiles) bundle = profiles.bundle(selection, overrides);
		else if (engine.has('profiles.resolve'))
			bundle = applyOverrides(
				await engine.call('profiles.resolve', { selection }, { signal: req.signal }),
				overrides
			);
		else throw new AppError(503, 'This slicer cannot resolve profiles. Update Print Lab Slicer.');

		const stlPath = path.join(dir, 'part.stl');
		fs.writeFileSync(stlPath, req.stl);
		const mesh = await engine.call(
			'mesh.put',
			{ meshId, path: stlPath, format: 'stl' },
			{ signal: req.signal }
		);
		projectId = (await engine.call('project.create', { presets: selection })).projectId;

		const project: Project = emptyProject(selection);
		project.meta.title = req.name;
		project.meta.application = 'Family Print Lab';
		// The exact model code for the file (the H2C has two); backends default to the preset's model.
		project.meta.extras = { printer_model_id: printer.code };
		project.filaments = [
			{
				index: 1,
				preset: selection.filaments[0],
				color: s.color ?? '#888888',
				type: String(bundle.filaments[0]?.config.filament_type?.[0] ?? 'PLA')
			}
		];
		project.meshes[meshId] = {
			id: meshId,
			triangles: mesh.triangles,
			vertices: mesh.triangles * 3,
			bbox: mesh.bbox,
			storage: { kind: 'file', path: stlPath }
		};
		project.objects = [
			{
				id: 'o1',
				name: req.name,
				parts: [
					{
						id: 'p1',
						name: req.name,
						type: 'model',
						mesh: meshId,
						transform: [...IDENTITY],
						config: {},
						filament: 1
					}
				],
				instances: [{ id: 'i1', transform: [...IDENTITY], printable: true }],
				config: {},
				heightRanges: [],
				printable: true
			}
		];
		project.plates = [
			{
				index: 1,
				name: '',
				locked: false,
				bedType: choice.bedType,
				instances: [{ objectId: 'o1', instanceId: 'i1' }],
				config: {}
			}
		];
		const sync = async () => {
			const r = await engine.call('project.sync', {
				projectId: projectId!,
				project,
				presets: bundle
			});
			if (r.errors.length) throw new AppError(422, r.errors.map((e) => e.message).join(' '));
		};
		await sync();

		// Lay it flat and place it, as the old one-shot command line did (--orient 1 --arrange 1).
		if (engine.has('orient')) {
			stage('Finding the best way up…');
			const { objects } = await engine.call('orient', { projectId, objectIds: ['o1'] }, opts);
			const t = objects.find((o) => o.objectId === 'o1')?.transform;
			if (t) project.objects[0].instances[0].transform = t;
			await sync();
		}
		if (engine.has('arrange')) {
			stage('Placing it on the plate…');
			const { instances } = await engine.call('arrange', { projectId, plate: 1 }, opts);
			const t = instances.find((i) => i.instanceId === 'i1')?.transform;
			if (t) project.objects[0].instances[0].transform = t;
			await sync();
		}

		stage(engine.info.engine === 'printlab-slicer' ? 'Slicing…' : 'Slicing in Bambu Studio…');
		const stats = await engine.call('slice', { projectId, plate: 1 }, opts);

		stage(`Preparing the file for the ${printer.short}…`);
		const thumbnail = req.thumbnail ? path.join(dir, 'plate_1.png') : null;
		if (thumbnail) fs.writeFileSync(thumbnail, req.thumbnail!);
		const out = path.join(dir, 'sliced.gcode.3mf');
		await engine.call(
			'export.gcode3mf',
			{
				projectId,
				plates: [1],
				path: out,
				thumbnails: thumbnail ? [{ plate: 1, thumbnail }] : 'engine'
			},
			{ signal: req.signal }
		);
		return {
			data: fs.readFileSync(out),
			choice,
			minutes: Math.max(1, Math.round(stats.seconds / 60)),
			grams: Math.round(stats.filaments.reduce((a, f) => a + f.grams, 0) * 10) / 10,
			backend: engine.info.engine,
			warnings: stats.warnings.map((w) => w.message)
		};
	} catch (e) {
		throw friendly(e);
	} finally {
		if (projectId) await engine.call('project.close', { projectId }).catch(() => {});
		if (engine.has('mesh.put'))
			await engine.call('mesh.drop', { meshIds: [meshId] }).catch(() => {});
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
