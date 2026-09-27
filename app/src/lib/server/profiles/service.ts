// What the slicer-profiles module offers the app: the profile library, user presets, a job's slicer
// settings (jobs.slice_overrides), a spool's filament preset (spools.filament_preset) and the preset
// for an AMS tray. A job slices with, in order: the presets picked for it, else its spool's filament
// preset, else the defaults for its printer model, nozzle, layer height and material; then the job's
// own fields (infill, supports, spool colour, the same mapping slicer.ts uses), then its key overrides.
import { eq } from 'drizzle-orm';
import type { DB } from '../db';
import { jobs, spools } from '../db/schema';
import type { Lab } from '../lab';
import type { PrinterManager } from '../printer/manager';
import { AppError, parse } from '../validation';
import { ProfileLibrary } from './library';
import { UserPresetStore } from './store';
import { filamentBundle, importPresets, presetJson, printerBundle, safeName } from './io';
import { locateProfiles } from './locate';
import {
	jobSliceSettings,
	presetRef,
	spoolPreset,
	userPresetInput,
	userPresetPatch
} from '../modules/slicer-profiles/validation';
import { MODEL_CODES, PRINTER_MODELS, type ModelCode } from '$lib/shared/printers/models';
import type { GlobalTray } from '$lib/shared/printers/status';
import type { ConfigMap, PresetRef, PresetSelection } from '$lib/shared/slicer/project';
import type { PresetSummary, ResolvedBundle } from '$lib/shared/slicer/profiles';
import type {
	JobSliceSettings,
	JobSliceView,
	PresetDetail,
	ProfilesOverview
} from '$lib/shared/slicer-profiles';

export interface ProfilesDeps {
	db: DB;
	lab: Lab;
	printers: PrinterManager;
	env: Record<string, string | undefined>;
	/** Where relative paths start (resources/…); default process.cwd(). */
	cwd?: string;
	/** Tells open tabs that user presets changed. */
	changed?: () => void;
}

export interface JobSlice {
	selection: PresetSelection;
	overrides: { printer?: ConfigMap; process?: ConfigMap; filaments?: ConfigMap[] };
}

export class SlicerProfiles {
	readonly profiles: ProfileLibrary;
	readonly store: UserPresetStore;

	constructor(private d: ProfilesDeps) {
		this.store = new UserPresetStore(d.db);
		this.profiles = new ProfileLibrary(this.store, () => locateProfiles(d.env, d.cwd));
	}

	overview(): ProfilesOverview {
		const v = this.profiles.vendor();
		const set = this.profiles.vendorSet();
		const loc = this.profiles.location();
		const models = MODEL_CODES.map((code) => {
			const m = PRINTER_MODELS[code];
			const entry = set?.models.get(m.name);
			const nozzles = set
				? (entry?.variants ?? []).filter((n) =>
						set
							.all('printer')
							.some((p) => p.config.printer_model === m.name && p.config.printer_variant === n)
					)
				: [];
			return {
				code,
				name: m.name,
				short: m.short,
				nozzles: nozzles.sort(),
				hasCover: !!entry?.cover
			};
		});
		return {
			vendor: v && loc ? { ...v, source: loc.source } : null,
			missing: this.profiles.missing(),
			models,
			users: this.store.list()
		};
	}

	/** The cover picture of a printer model from the vendor folder (PNG), if there is one. */
	cover(code: string): { path: string } | null {
		const m = PRINTER_MODELS[code as ModelCode];
		const set = this.profiles.vendorSet();
		const cover = m && set?.models.get(m.name)?.cover;
		return cover ? { path: `${set.dir}/${set.vendor}/${cover}` } : null;
	}

	detail(input: unknown): PresetDetail {
		const ref = parse(presetRef, input) as PresetRef;
		const preset = this.profiles.resolve(ref);
		const user = ref.source === 'user' ? this.profiles.userPreset(ref) : null;
		const summary =
			this.profiles
				.list(ref.kind, { includeHidden: true })
				.find((s) => (user ? s.id === user.id : s.source === 'system' && s.name === ref.name)) ??
			null;
		return { preset, summary, user, pages: this.profiles.pages(ref) };
	}

	// ---------- User presets ----------

	createUser(input: unknown) {
		const p = parse(userPresetInput, input);
		const { inherits, config } = this.profiles.derive(
			p.kind,
			p.name,
			p.from as PresetRef | null,
			p.config
		);
		const created = this.store.create({ kind: p.kind, name: p.name, inherits, config });
		this.d.changed?.();
		return created;
	}

	updateUser(id: string, input: unknown) {
		const p = parse(userPresetPatch, input);
		const before = this.profiles.userPreset(id);
		if (p.name && p.name !== before.name && this.profiles.vendorSet()?.get(before.kind, p.name))
			throw new AppError(409, `“${p.name}” is the name of a system preset. Pick another name.`);
		const updated = this.store.update(id, p.version, {
			name: p.name,
			config: p.config ? this.profiles.normalise(before, p.config) : undefined
		});
		this.d.changed?.();
		return updated;
	}

	removeUser(id: string) {
		this.store.remove(id);
		this.d.changed?.();
	}

	importFile(file: { name: string; data: Buffer }) {
		const result = importPresets(this.profiles, this.store, file);
		if (result.imported.length) this.d.changed?.();
		return result;
	}

	/** A user preset as Bambu Studio's .json, or with `bundle` as a .bbscfg (printer) / .bbsflmt (filament). */
	exportUser(id: string, bundle = false): { name: string; type: string; data: Buffer } {
		const u = this.profiles.userPreset(id);
		// Bambu Studio needs a version it can parse: the tag, else the vendor set's own version.
		const v = this.profiles.vendor();
		const tag = v && /^v?\d+\.\d+\.\d+/.test(v.tag) ? v.tag : (v?.version ?? '02.00.00.00');
		const safe = safeName(u.name);
		if (bundle && u.kind === 'printer')
			return {
				name: `${safe}.bbscfg`,
				type: 'application/zip',
				data: printerBundle(this.profiles, this.store, u, tag)
			};
		if (bundle && u.kind === 'filament')
			return {
				name: `${safe.split('@')[0].trim() || safe}.bbsflmt`,
				type: 'application/zip',
				data: filamentBundle(this.profiles, this.store, u, tag)
			};
		return {
			name: `${safe}.json`,
			type: 'application/json',
			data: Buffer.from(JSON.stringify(presetJson(u, tag), null, 4))
		};
	}

	// ---------- Jobs ----------

	private jobRow(id: string) {
		const job = this.d.db.select().from(jobs).where(eq(jobs.id, id)).get();
		if (!job) throw new AppError(404, 'That print job no longer exists.');
		return job;
	}

	private spoolRow(id: string | null) {
		return id ? this.d.db.select().from(spools).where(eq(spools.id, id)).get() : undefined;
	}

	/** The printer model a job slices for: its printer's, else the first printer's, else the X2D (as printing.ts). */
	private modelFor(printerId: string | null): ModelCode {
		if (printerId) {
			const saved = this.d.printers.info().find((p) => p.id === printerId);
			if (saved) return saved.model;
		}
		return this.d.printers.primary()?.model.code ?? 'N6';
	}

	jobSettings(jobId: string): JobSliceSettings {
		return this.jobRow(jobId).sliceOverrides ?? {};
	}

	setJobSettings(jobId: string, input: unknown): JobSliceSettings {
		this.jobRow(jobId);
		const s = parse(jobSliceSettings, input) as JobSliceSettings;
		for (const ref of [s.printer, s.process, ...(s.filaments ?? [])])
			if (ref) this.profiles.resolve(ref); // a clear error now rather than at slicing time
		const empty =
			!s.printer &&
			!s.process &&
			!s.filaments?.length &&
			!Object.values(s.overrides ?? {}).some((o) =>
				Array.isArray(o) ? o.some((m) => Object.keys(m).length) : Object.keys(o ?? {}).length
			);
		this.d.db
			.update(jobs)
			.set({ sliceOverrides: empty ? null : s })
			.where(eq(jobs.id, jobId))
			.run();
		this.d.lab.touch('job');
		return empty ? {} : s;
	}

	/**
	 * The presets and overrides a job slices with. A preset that no longer exists, or that does not suit
	 * the job's printer (the job moved to another printer), is replaced like Bambu Studio replaces an
	 * incompatible preset when the printer changes: filaments by the same Bambu filament in the
	 * printer's variant, anything else by the printer's default.
	 */
	forJob(jobId: string): JobSlice {
		const job = this.jobRow(jobId);
		const spool = this.spoolRow(job.spoolId);
		const s = job.sliceOverrides ?? {};
		const model = this.modelFor(job.printerId);
		const nozzle = job.nozzle || '0.4';
		const material = job.material || spool?.material || 'PLA';
		const lib = this.profiles;
		const alive = <T extends PresetRef>(r: T | null | undefined): T | null =>
			r && r.kind && lib.exists(r) ? r : null;
		const printer: PresetRef = alive(s.printer) ?? {
			kind: 'printer',
			name: lib.printerFor(model, nozzle).name,
			source: 'system'
		};
		// Defaults are only worked out for what is missing (a job may pick a filament for a material
		// the printer has no preset for).

		let process = alive(s.process);
		if (process && !lib.suits(process, printer)) process = null;
		if (!process) {
			const layer = Number(job.layerHeight);
			const picked =
				Number.isFinite(layer) && layer > 0
					? lib.pickProcess(
							lib.compatible(printer, 'process').filter((p) => p.source === 'system'),
							layer
						)
					: undefined;
			process = picked
				? { kind: 'process', name: picked.name, source: 'system' }
				: lib.defaultProcess(printer);
		}
		const chosen = (s.filaments ?? [])
			.map((r) => alive(r))
			.map((r) => (r ? this.forPrinter(r, printer) : null));
		const spoolPreset = alive(spool?.filamentPreset);
		const fromSpool = spoolPreset ? this.forPrinter(spoolPreset, printer) : null;
		const filaments = chosen.length
			? chosen.map(
					(r, i) => r ?? (i === 0 ? fromSpool : null) ?? lib.defaultFilament(printer, material)
				)
			: [fromSpool ?? lib.defaultFilament(printer, material)];

		// The job's own fields, as slicer.ts applies them to the command line's presets.
		const fromJob: ConfigMap = {};
		if (job.infill !== null && job.infill >= 0 && job.infill <= 100)
			fromJob.sparse_infill_density = `${Math.round(job.infill)}%`;
		if (job.supports === 'None' || job.supports === 'Normal' || job.supports === 'Tree') {
			fromJob.enable_support = job.supports === 'None' ? '0' : '1';
			if (job.supports !== 'None')
				fromJob.support_type = job.supports === 'Tree' ? 'tree(auto)' : 'normal(auto)';
		}
		const colour =
			spool?.colorHex && /^#?[0-9a-f]{6}$/i.test(spool.colorHex)
				? `#${spool.colorHex.replace('#', '').toUpperCase()}`
				: null;
		const o = s.overrides ?? {};
		return {
			selection: { printer, process, filaments },
			overrides: {
				printer: o.printer,
				process: { ...fromJob, ...(o.process ?? {}) },
				filaments: filaments.map((_, i) => ({
					...(i === 0 && colour ? { filament_colour: [colour] } : {}),
					...(o.filaments?.[i] ?? {})
				}))
			}
		};
	}

	/**
	 * A filament preset for another printer: itself when it suits the printer, else the same Bambu
	 * filament (filament_id) in that printer's variant ("Bambu PLA Basic @BBL X1C" → "… @BBL A1M"),
	 * else null.
	 */
	private forPrinter(ref: PresetRef, printer: PresetRef): PresetRef | null {
		if (this.profiles.suits(ref, printer)) return ref;
		if (ref.source !== 'system') return null;
		const id = this.profiles.vendorSet()?.get('filament', ref.name)?.filamentId;
		const same = id
			? this.profiles
					.compatible(printer, 'filament')
					.find((f) => f.source === 'system' && f.filamentId === id)
			: undefined;
		return same ? { kind: 'filament', name: same.name, source: 'system' } : null;
	}

	/** The flat config a job slices with (slicer-engine calls this when both are present). */
	bundleForJob(jobId: string): ResolvedBundle {
		const { selection, overrides } = this.forJob(jobId);
		return this.profiles.bundle(selection, overrides);
	}

	jobView(jobId: string): JobSliceView {
		const job = this.jobRow(jobId);
		const view: JobSliceView = {
			settings: job.sliceOverrides ?? {},
			selection: null,
			model: this.modelFor(job.printerId),
			nozzle: job.nozzle || '0.4',
			processes: [],
			filaments: [],
			error: null
		};
		try {
			view.selection = this.forJob(jobId).selection;
			view.processes = this.profiles.compatible(view.selection.printer, 'process');
			view.filaments = this.profiles.compatible(view.selection.printer, 'filament');
		} catch (e) {
			if (!(e instanceof AppError)) throw e;
			view.error = e.message;
		}
		return view;
	}

	// ---------- Spools and trays ----------

	spoolPreset(spoolId: string): PresetRef | null {
		const spool = this.spoolRow(spoolId);
		if (!spool) throw new AppError(404, 'That spool no longer exists.');
		return spool.filamentPreset ?? null;
	}

	setSpoolPreset(spoolId: string, input: unknown): PresetRef | null {
		if (!this.spoolRow(spoolId)) throw new AppError(404, 'That spool no longer exists.');
		const { preset } = parse(spoolPreset, input);
		if (preset) {
			if (preset.kind !== 'filament') throw new AppError(400, 'Pick a filament preset.');
			this.profiles.resolve(preset as PresetRef);
		}
		this.d.db
			.update(spools)
			.set({ filamentPreset: (preset as PresetRef | null) ?? null })
			.where(eq(spools.id, spoolId))
			.run();
		this.d.lab.touch('spool');
		return (preset as PresetRef | null) ?? null;
	}

	/**
	 * The filament preset for what is loaded in a printer's tray: its tray_info_idx is the Bambu
	 * filament_id (Bambu Studio DevFilaSystem.cpp ~788 reads it into the tray's setting_id).
	 */
	filamentForTray(printerId: string, tray: GlobalTray): PresetSummary | null {
		const status = this.d.printers.statuses().find((p) => p.id === printerId);
		const snap = status?.state;
		if (!status?.model || !snap) return null;
		const unit = snap.ams.find((u) => u.trays.some((t) => t.global === tray));
		const found = [...(unit?.trays ?? []), ...snap.externalSpools].find((t) => t.global === tray);
		if (!found?.infoIdx) return null;
		// The nozzle the tray feeds (dual-nozzle printers), else the only one.
		const diameter =
			snap.nozzles.find((n) => n.id === (unit?.nozzle ?? 0))?.diameter ?? snap.nozzles[0]?.diameter;
		try {
			const printer = this.profiles.printerFor(status.model, String(diameter ?? '0.4'));
			return this.profiles.filamentForTray(found.infoIdx, {
				kind: 'printer',
				name: printer.name,
				source: 'system'
			});
		} catch (e) {
			if (e instanceof AppError) return null;
			throw e;
		}
	}
}
