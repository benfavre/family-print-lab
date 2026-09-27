// Calibration: Print Lab Slicer makes the test (calib.generate, features/calib in the engine) for a
// printer and filament, slices it, and the sliced file becomes a queued job on the family's
// Calibration project; once printed, the value picked from the print goes into a user filament preset
// (slicer-profiles) that the spool then slices with. Also the printer's own flow dynamics and flow rate
// calibration and its K-value profiles (commands in printer/commands/defs/slicer-calibration.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { DB } from '../../db';
import { calibrationRuns, spools } from '../../db/schema';
import type { Lab } from '../../lab';
import type { PrinterManager } from '../../printer/manager';
import { PrinterRefused } from '../../printer/bambu';
import type { CommandName } from '../../printer/commands/registry';
import type { PrintFiles } from '../../printing';
import type { SettingsStore } from '../../module-settings';
import { EngineError, type SlicerEngine } from '../../slicer/engine';
import { bedTypeFor } from '../../slicer/profile-book';
import type { TaskCenter, TaskContext } from '../../tasks';
import { AppError, parse } from '../../validation';
import type { QueueService } from '../contracts';
import type { SlicerProfilesService } from '../slicer-profiles/module';
import {
	CALIB_KINDS,
	CALIB_TESTS,
	calibChanges,
	calibDefaults,
	calibProblem,
	flowCalibrationReason,
	nozzleVolumeOfType,
	paCalibrationReason,
	parseFlowResults,
	parseKProfiles,
	type CalibAvailability,
	type CalibKind,
	type CalibOverview,
	type CalibParams,
	type CalibResult,
	type CalibRun,
	type FlowRatioResult,
	type KProfile,
	type PrinterCalibInfo
} from '$lib/shared/slicer-calibration';
import { ERROR, type Progress } from '$lib/shared/slicer/protocol';
import type { ConfigMap, ConfigValue, PresetRef } from '$lib/shared/slicer/project';
import { EXT_DEPUTY, type PrinterTray } from '$lib/shared/printers/status';
import { capabilitiesFor } from '$lib/shared/printers/models';
import {
	calibEnqueueInput,
	calibResultInput,
	calibRunInput,
	kProfileDelete,
	kProfileQuery,
	kProfileSave,
	kProfileSelect,
	printerCalibStart,
	printerResultQuery
} from './validation';

export interface CalibrationDeps {
	db: DB;
	lab: Lab;
	printers: PrinterManager;
	tasks: TaskCenter;
	printing: PrintFiles;
	settings: SettingsStore<{ projectId: string | null }>;
	openSlicer: () => Promise<SlicerEngine | null>;
	profiles: () => SlicerProfilesService | undefined;
	queue: () => QueueService | undefined;
	/** Tells open tabs that runs changed. */
	changed?: () => void;
	/** Scratch space for sliced files (default: the OS temp directory). */
	workDir?: string;
}

type Row = typeof calibrationRuns.$inferSelect;

/** What every test needs from the slicer besides its own calib.<kind>. */
const NEEDED = ['slice', 'export.gcode3mf'] as const;

const first = (v: ConfigValue | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const num = (v: ConfigValue | undefined, fallback: number) => {
	const n = parseFloat(first(v));
	return Number.isFinite(n) ? n : fallback;
};

function toRun(r: Row): CalibRun {
	return {
		id: r.id,
		kind: r.kind,
		status: r.status,
		title: r.title,
		printerId: r.printerId,
		spoolId: r.spoolId,
		filament: r.filament ?? null,
		params: r.params,
		steps: r.steps,
		baseFlowRatio: r.baseFlowRatio,
		jobId: r.jobId,
		taskId: r.taskId,
		result: r.result ?? null,
		error: r.error,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	};
}

/** Plain words for the task list and the run from an engine's progress. */
const stageText = (p: Progress) => p.message || `${p.stage[0].toUpperCase()}${p.stage.slice(1)}…`;

/** Plain words for the reasons a printer gives when it refuses a calibration (DevCalib.cpp calib_fail_message). */
const REFUSALS: Record<string, string> = {
	'invalid nozzle_diameter': 'The printer cannot calibrate with this nozzle size.',
	'nozzle_diameter is not supported': 'The printer cannot calibrate with this nozzle size.',
	'nozzle_diameter is not matched':
		'The nozzle size does not match the printer’s. Check the nozzle set on the printer.',
	'invalid handle_flowrate_cali param': 'The printer did not accept the flow rate settings.',
	'generate auto filament cali gcode failure': 'The printer could not make its calibration print.'
};

export class Calibration {
	constructor(private d: CalibrationDeps) {}

	/** Runs left slicing when the app stopped will never finish: marks them failed (on start). */
	recover() {
		const stuck = this.d.db
			.select({ id: calibrationRuns.id })
			.from(calibrationRuns)
			.where(eq(calibrationRuns.status, 'slicing'))
			.all();
		for (const r of stuck)
			this.update(r.id, { status: 'failed', error: 'Stopped when the app restarted. Try again.' });
	}

	// ---------- Tests ----------

	/** Which tests the installed slicer can make, and why not when it cannot. */
	availability(engine: SlicerEngine | null): CalibAvailability[] {
		const profiles = !!this.d.profiles();
		return CALIB_KINDS.map((kind) => {
			let reason: string | null = null;
			if (!engine) reason = 'No slicer is installed. See Integrations.';
			else if (engine.info.engine !== 'printlab-slicer')
				reason =
					'Needs Print Lab Slicer: the Bambu Studio command line cannot make calibration tests.';
			else if (!engine.has(`calib.${kind}`) || NEEDED.some((c) => !engine.has(c)))
				reason = 'This version of Print Lab Slicer cannot make this test. Update it.';
			else if (!profiles) reason = 'Needs the slicer profiles (see Integrations).';
			return { kind, available: !reason, reason };
		});
	}

	async overview(): Promise<CalibOverview> {
		const engine = await this.d.openSlicer().catch(() => null);
		const projectId = this.d.settings.get().projectId;
		return {
			engine: engine ? { name: engine.info.engine, version: engine.info.version ?? null } : null,
			tests: this.availability(engine),
			runs: this.runs(),
			projectId: projectId && this.d.lab.projectTitle(projectId) !== undefined ? projectId : null,
			queue: !!this.d.queue()
		};
	}

	runs(): CalibRun[] {
		return this.d.db
			.select()
			.from(calibrationRuns)
			.orderBy(desc(calibrationRuns.createdAt))
			.limit(100)
			.all()
			.map(toRun);
	}

	get(id: string): CalibRun {
		return toRun(this.row(id));
	}

	private row(id: string): Row {
		const row = this.d.db.select().from(calibrationRuns).where(eq(calibrationRuns.id, id)).get();
		if (!row) throw new AppError(404, 'That calibration run no longer exists.');
		return row;
	}

	private update(id: string, set: Partial<Row>) {
		this.d.db
			.update(calibrationRuns)
			.set({ ...set, updatedAt: new Date().toISOString() })
			.where(eq(calibrationRuns.id, id))
			.run();
		this.d.changed?.();
	}

	remove(id: string) {
		const row = this.row(id);
		// Still slicing: stop it, so no job turns up for a run that is gone.
		if (row.status === 'slicing' && row.taskId)
			try {
				this.d.tasks.cancel(row.taskId);
			} catch {
				// The task is already gone.
			}
		this.d.db.delete(calibrationRuns).where(eq(calibrationRuns.id, id)).run();
		this.d.changed?.();
	}

	/**
	 * Starts a test: works out the presets for the printer and filament, then slices in the background
	 * (the run shows 'slicing' until the job is ready). Returns the run at once.
	 */
	async create(input: unknown): Promise<CalibRun> {
		const o = parse(calibRunInput, input);
		const kind = o.kind as CalibKind;
		const printer = this.d.printers.info().find((p) => p.id === o.printerId);
		if (!printer) throw new AppError(404, 'That printer no longer exists.');
		const engine = await this.d.openSlicer();
		const available = this.availability(engine).find((a) => a.kind === kind)!;
		if (!available.available) throw new AppError(503, available.reason!);
		const sp = this.d.profiles()!;
		const spool = o.spoolId
			? this.d.db.select().from(spools).where(eq(spools.id, o.spoolId)).get()
			: undefined;
		if (o.spoolId && !spool) throw new AppError(404, 'That spool no longer exists.');
		const material = spool?.material || 'PLA';
		const params: CalibParams = { ...calibDefaults(kind, { material }), ...o.params };
		const problem = calibProblem(kind, params);
		if (problem) throw new AppError(400, problem);

		// The printer's own preset for its nozzle, its default process, and the filament asked for.
		const nozzle = String(
			this.d.printers.statuses().find((s) => s.id === printer.id)?.state?.nozzles[0]?.diameter ??
				'0.4'
		);
		const lib = sp.profiles;
		const printerRef: PresetRef = {
			kind: 'printer',
			name: lib.printerFor(printer.model, nozzle).name,
			source: 'system'
		};
		let filament = (o.filament as PresetRef | null) ?? spool?.filamentPreset ?? null;
		if (filament && (!lib.exists(filament) || !lib.suits(filament, printerRef))) filament = null;
		filament ??= lib.defaultFilament(printerRef, material);
		const selection = {
			printer: printerRef,
			process: lib.defaultProcess(printerRef),
			filaments: [filament]
		};
		const colour =
			spool?.colorHex && /^#[0-9a-f]{6}$/i.test(spool.colorHex)
				? spool.colorHex.toUpperCase()
				: null;
		const bundle = lib.bundle(selection, {
			filaments: [colour ? { filament_colour: [colour] } : {}]
		});
		const projectId = this.calibrationProject(o.profileId);

		const id = crypto.randomUUID();
		const test = CALIB_TESTS[kind];
		this.d.db
			.insert(calibrationRuns)
			.values({
				id,
				kind,
				title: test.title,
				printerId: printer.id,
				spoolId: spool?.id ?? null,
				filament,
				params
			})
			.run();
		const task = this.d.tasks.start(
			{
				kind: 'slice',
				title: `Calibration: ${test.title}`,
				projectId,
				stage: 'Setting up the test…'
			},
			(ctx) =>
				this.make(id, ctx, {
					engine: engine!,
					kind,
					params,
					selection,
					bundle,
					bedType: bedTypeFor(''),
					projectId,
					printerId: printer.id,
					spoolId: spool?.id ?? null,
					material,
					nozzle
				}).catch((e) => {
					const message =
						e instanceof EngineError && e.code === ERROR.CANCELLED
							? 'Stopped.'
							: (e as Error).message || 'Something went wrong.';
					this.update(id, { status: 'failed', error: message });
					throw e;
				}),
			(r) => ({ stage: r })
		);
		this.update(id, { taskId: task.id });
		return this.get(id);
	}

	/** The task: generate, slice, export, then a queued job holding the file. */
	private async make(
		runId: string,
		ctx: TaskContext,
		o: {
			engine: SlicerEngine;
			kind: CalibKind;
			params: CalibParams;
			selection: { printer: PresetRef; process: PresetRef; filaments: PresetRef[] };
			bundle: ReturnType<SlicerProfilesService['profiles']['bundle']>;
			bedType: string;
			projectId: string;
			printerId: string;
			spoolId: string | null;
			material: string;
			nozzle: string;
		}
	): Promise<string> {
		const { engine } = o;
		const generated = await engine.call(
			'calib.generate',
			{
				kind: o.kind,
				params: o.params,
				selection: o.selection,
				presets: o.bundle,
				bedType: o.bedType
			},
			{ signal: ctx.signal, timeoutMs: 5 * 60_000 }
		);
		const dir = this.d.workDir ?? os.tmpdir();
		const out = path.join(dir, `calib-${runId}.gcode.3mf`);
		try {
			ctx.stage('Slicing…');
			const stats = await engine.call(
				'slice',
				{ projectId: generated.projectId, plate: 1 },
				{ signal: ctx.signal, onProgress: (p) => ctx.stage(stageText(p)) }
			);
			ctx.stage('Preparing the file…');
			fs.mkdirSync(dir, { recursive: true });
			await engine.call(
				'export.gcode3mf',
				{ projectId: generated.projectId, plates: [1], path: out, thumbnails: 'engine' },
				{ signal: ctx.signal }
			);
			const data = fs.readFileSync(out);
			// Removed while slicing: nothing to make a job for.
			if (!this.d.db.select().from(calibrationRuns).where(eq(calibrationRuns.id, runId)).get())
				return 'Removed.';
			const minutes = Math.max(1, Math.round(stats.seconds / 60));
			const grams = Math.round(stats.filaments.reduce((a, f) => a + f.grams, 0) * 10) / 10;
			const jobId = this.d.lab.createJob({
				projectId: o.projectId,
				printerId: o.printerId,
				spoolId: o.spoolId,
				material: o.material,
				nozzle: o.nozzle,
				minutes,
				grams,
				notes: `${generated.title}, made by the calibration wizard.`
			});
			this.d.printing.attach(jobId, data, `${generated.title}.gcode.3mf`, 'app');
			this.update(runId, {
				status: 'ready',
				title: generated.title,
				steps: generated.steps,
				baseFlowRatio: generated.baseFlowRatio ?? null,
				jobId,
				error: null
			});
			return `${minutes} min · ${grams} g`;
		} finally {
			await engine.call('project.close', { projectId: generated.projectId }).catch(() => {});
			fs.rmSync(out, { force: true });
		}
	}

	/** The family project calibration prints go into, made on first use (owned by a grown-up). */
	private calibrationProject(profileId: string | null): string {
		const saved = this.d.settings.get().projectId;
		if (saved && this.d.lab.projectTitle(saved) !== undefined) return saved;
		const profiles = this.d.lab.snapshot().profiles;
		const owner =
			profiles.find((p) => p.id === profileId) ?? profiles.find((p) => !p.kid) ?? profiles[0];
		if (!owner)
			throw new AppError(409, 'Add a family member first: calibration prints need a project.');
		const id = this.d.lab.createProject({
			profileId: owner.id,
			title: 'Calibration',
			category: 'Home lab',
			status: 'Printing',
			description: 'Test prints from the calibration wizard.',
			checklist: []
		});
		this.d.settings.set({ projectId: id });
		return id;
	}

	/** Adds the run's job to the print queue (for its printer, or the one given). */
	enqueue(id: string, input: unknown) {
		const o = parse(calibEnqueueInput, input ?? {});
		const run = this.row(id);
		if (!run.jobId) throw new AppError(409, 'The test is not sliced yet.');
		const queue = this.d.queue();
		if (!queue)
			throw new AppError(503, 'The print queue is not running. Send the job from its project.');
		queue.enqueue(run.jobId, {
			printerId: o.printerId === undefined ? run.printerId : o.printerId
		});
		return this.get(id);
	}

	/**
	 * The value picked from the print. With `save`, it goes into a user filament preset: the run's own
	 * when that is a user preset, else "<system preset> - calibrated" (made once, updated after), and the
	 * run's spool then slices with it.
	 */
	setResult(id: string, input: unknown): CalibRun {
		const o = parse(calibResultInput, input);
		const run = this.row(id);
		if (run.status !== 'ready' && run.status !== 'done')
			throw new AppError(409, 'Slice and print the test first.');
		const changes = calibChanges(run.kind, o.value);
		let preset: PresetRef | null = null;
		let spoolUpdated = false;
		if (o.save && Object.keys(changes).length && run.filament) {
			const sp = this.d.profiles();
			if (!sp) throw new AppError(503, 'The slicer profiles are not available to save into.');
			preset = this.savePreset(sp, run.filament, changes);
			if (run.spoolId && this.d.db.select().from(spools).where(eq(spools.id, run.spoolId)).get()) {
				sp.lab.setSpoolPreset(run.spoolId, { preset });
				spoolUpdated = true;
			}
		}
		const result: CalibResult = {
			value: o.value,
			label: o.label,
			preset,
			spoolUpdated,
			at: new Date().toISOString()
		};
		this.update(id, { status: 'done', result });
		return this.get(id);
	}

	private savePreset(sp: SlicerProfilesService, ref: PresetRef, changes: ConfigMap): PresetRef {
		const lab = sp.lab;
		const existing =
			ref.source === 'user'
				? (lab.store.get(ref.userPresetId ?? '') ?? lab.store.byName('filament', ref.name))
				: lab.store.byName('filament', `${ref.name} - calibrated`);
		if (existing) {
			const updated = lab.updateUser(existing.id, {
				version: existing.version,
				config: { ...existing.config, ...changes }
			});
			return { kind: 'filament', name: updated.name, source: 'user', userPresetId: updated.id };
		}
		const created = lab.createUser({
			kind: 'filament',
			name: `${ref.name} - calibrated`,
			from: ref,
			config: changes
		});
		return { kind: 'filament', name: created.name, source: 'user', userPresetId: created.id };
	}

	// ---------- The printer's own calibration ----------

	private printer(printerId: string) {
		const p = this.d.printers.require(printerId);
		const status = this.d.printers.statuses().find((s) => s.id === printerId);
		return { p, status, snap: status?.state ?? null };
	}

	info(printerId: string): PrinterCalibInfo {
		const { p, status, snap } = this.printer(printerId);
		const caps = status?.caps ?? capabilitiesFor(p.model.code, null);
		const nozzles = (snap?.nozzles.length ? snap.nozzles : [null]).map((n, i) => ({
			id: n?.id ?? i,
			diameter: n?.diameter ?? 0.4,
			volume: nozzleVolumeOfType(n?.type)
		}));
		const main = nozzles.find((n) => n.id === 0) ?? nozzles[0];
		// The extruder each tray feeds: its AMS unit's (info bits 8–11), the external spools their own
		// (Bambu Studio DevFilaSystem.cpp GetExtruderIdByAmsId: 255 main (0), 254 deputy (1)).
		const trays: (PrinterTray & { extruderId: number })[] = [
			...(snap?.ams.flatMap((u) => u.trays.map((t) => ({ ...t, extruderId: u.nozzle ?? 0 }))) ??
				[]),
			...(snap?.externalSpools ?? []).map((t) => ({
				...t,
				extruderId: t.global === EXT_DEPUTY ? 1 : 0
			}))
		];
		return {
			printerId,
			pa: paCalibrationReason(caps, snap, p.model.series),
			flow: flowCalibrationReason(caps, snap, p.model.series),
			nozzleDiameter: main.diameter,
			nozzleVolume: main.volume,
			nozzles,
			trays: trays
				.filter((t) => t.type)
				.map((t) => ({
					global: t.global,
					extruderId: t.extruderId,
					label: t.name || t.slot,
					type: t.type,
					color: t.color,
					filamentId: t.infoIdx,
					k: t.k
				}))
		};
	}

	/** The nozzle an extruder carries (the main one when there is no such extruder). */
	private nozzleOf(info: PrinterCalibInfo, extruderId: number) {
		return info.nozzles.find((n) => n.id === extruderId) ?? info.nozzles[0];
	}

	/** Sends a calibration command, with the printer's refusals in plain words. */
	private async send(printerId: string, name: CommandName, params: Record<string, unknown>) {
		const { p } = this.printer(printerId);
		try {
			return await p.send(name, params);
		} catch (e) {
			if (e instanceof PrinterRefused && REFUSALS[e.message])
				throw new AppError(409, REFUSALS[e.message]);
			throw e;
		}
	}

	private async ask(printerId: string, name: CommandName, params: Record<string, unknown>) {
		const r = await this.send(printerId, name, params);
		if (!r.reply)
			throw new AppError(504, 'The printer did not answer. Check that it is on and try again.');
		return r.reply;
	}

	/**
	 * The profiles for one nozzle size (the main nozzle's, or the given extruder's): Bambu Studio's
	 * history dialog asks by diameter alone, without extruder or nozzle id (CaliHistoryDialog.cpp ~324).
	 */
	async kProfiles(printerId: string, input: unknown): Promise<KProfile[]> {
		const o = parse(kProfileQuery, input ?? {});
		const info = this.info(printerId);
		const reply = await this.ask(printerId, 'print.extrusion_cali_get', {
			nozzleDiameter: this.nozzleOf(info, o.extruderId ?? 0).diameter,
			...(o.filamentId ? { filamentId: o.filamentId } : {})
		});
		return parseKProfiles(reply);
	}

	/**
	 * Saves a profile. The extruder defaults to the one feeding the tray (or a tray holding that
	 * filament), the flow type and diameter to that extruder's nozzle, and the setting id to the
	 * filament preset for that tray (Bambu Studio always sends the preset's setting_id).
	 */
	async saveKProfile(printerId: string, input: unknown) {
		const o = parse(kProfileSave, input);
		const info = this.info(printerId);
		const tray =
			info.trays.find((t) => t.global === o.tray) ??
			info.trays.find((t) => t.filamentId === o.filamentId);
		const extruderId = o.extruderId ?? tray?.extruderId ?? 0;
		const nozzle = this.nozzleOf(info, extruderId);
		const settingId =
			o.settingId ||
			(tray
				? (this.d.profiles()?.lab.filamentForTray(printerId, tray.global)?.settingId ?? '')
				: '');
		await this.send(printerId, 'print.extrusion_cali_set', {
			nozzleDiameter: nozzle.diameter,
			profiles: [{ ...o, extruderId, settingId, nozzleVolume: o.nozzleVolume ?? nozzle.volume }]
		});
		return this.kProfiles(printerId, { filamentId: o.filamentId, extruderId });
	}

	async selectKProfile(printerId: string, input: unknown) {
		const o = parse(kProfileSelect, input);
		const info = this.info(printerId);
		const tray = info.trays.find((t) => t.global === o.tray);
		if (!tray) throw new AppError(400, 'That tray is empty.');
		await this.send(printerId, 'print.extrusion_cali_sel', {
			...o,
			nozzleDiameter: this.nozzleOf(info, tray.extruderId).diameter
		});
		return { ok: true };
	}

	async deleteKProfile(printerId: string, input: unknown) {
		const o = parse(kProfileDelete, input);
		const nozzle = this.nozzleOf(this.info(printerId), o.extruderId);
		await this.send(printerId, 'print.extrusion_cali_del', {
			...o,
			nozzleVolume: o.nozzleVolume ?? nozzle.volume,
			nozzleDiameter: nozzle.diameter
		});
		return this.kProfiles(printerId, { filamentId: o.filamentId, extruderId: o.extruderId });
	}

	/**
	 * Starts the printer's own calibration for some trays, with each tray's filament preset (the
	 * temperatures, flow ratio and max volumetric speed Bambu Studio sends, CalibrationWizard*.cpp).
	 */
	async startOnPrinter(printerId: string, input: unknown) {
		const o = parse(printerCalibStart, input);
		const info = this.info(printerId);
		const sp = this.d.profiles();
		const filaments = o.trays.map((global) => {
			const tray = info.trays.find((t) => t.global === global);
			if (!tray) throw new AppError(400, 'That tray is empty.');
			if (!tray.filamentId)
				throw new AppError(
					400,
					'Set the filament of that tray on the printer (or in the AMS view) first.'
				);
			const summary = sp?.lab.filamentForTray(printerId, global) ?? null;
			const config: ConfigMap = summary
				? sp!.profiles.resolve({
						kind: 'filament',
						name: summary.name,
						source: summary.source,
						...(summary.source === 'user' ? { userPresetId: summary.id } : {})
					}).config
				: {};
			const nozzle = this.nozzleOf(info, tray.extruderId);
			return {
				tray: global,
				extruderId: tray.extruderId,
				bedTemp: Math.round(num(config.hot_plate_temp ?? config.textured_plate_temp, 55)),
				nozzleTemp: Math.round(num(config.nozzle_temperature, 220)),
				filamentId: tray.filamentId,
				settingId: summary?.settingId ?? '',
				flowRatio: num(config.filament_flow_ratio, 0.98),
				maxVolumetricSpeed: num(config.filament_max_volumetric_speed, 12),
				nozzleVolume: nozzle.volume,
				nozzleDiameter: nozzle.diameter
			};
		});
		// The top-level nozzle diameter is the first filament's (command_start_pa_calibration and
		// command_start_flow_ratio_calibration both read calib_datas[0]).
		const nozzleDiameter = filaments[0].nozzleDiameter;
		if (o.kind === 'pa')
			return this.send(printerId, 'print.extrusion_cali', {
				nozzleDiameter,
				mode: 0,
				filaments: filaments.map(({ flowRatio: _flow, ...f }) => f)
			});
		return this.send(printerId, 'print.flowrate_cali', {
			nozzleDiameter,
			filaments: filaments.map(({ nozzleVolume: _volume, nozzleDiameter: _diameter, ...f }) => f)
		});
	}

	async resultsOnPrinter(
		printerId: string,
		input: unknown
	): Promise<{ pa: KProfile[] } | { flow: FlowRatioResult[] }> {
		const o = parse(printerResultQuery, input);
		const info = this.info(printerId);
		const nozzleDiameter = this.nozzleOf(info, o.extruderId ?? 0).diameter;
		if (o.kind === 'pa')
			return {
				pa: parseKProfiles(
					await this.ask(printerId, 'print.extrusion_cali_get_result', { nozzleDiameter })
				)
			};
		return {
			flow: parseFlowResults(
				await this.ask(printerId, 'print.flowrate_get_result', { nozzleDiameter })
			)
		};
	}
}
