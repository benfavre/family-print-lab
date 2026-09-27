// The ProfileService (shared/slicer/profiles.ts): Bambu Studio's system presets (vendor.ts) plus the
// user's presets (store.ts), resolved, filtered and combined the way upstream's PresetBundle does at the
// tag in slicer/upstream.lock (src/libslic3r/Preset.cpp, PresetBundle.cpp):
//   - compatibility: a preset with compatible_printers lists printer preset names; without the list its
//     compatible_printers_condition is evaluated against the printer's config (a condition that does
//     not parse means compatible); a user printer preset also matches its system parent's name
//     (is_compatible_with_printer / is_compatible_with_parent_printer, Preset.cpp ~751–820);
//   - user presets store only the keys they change; a "nil" slot in a per-extruder array means "the
//     parent's value" (PresetBundle::import_json_presets, update_diff_values_to_child_config);
//   - bundle(): process, then printer, then the filaments (one filament applied whole, several merged
//     key by key: vectors appended in filament order, scalars from the first), then the bookkeeping
//     keys (print/filament/printer_settings_id, filament_ids, inherits_group,
//     different_settings_to_system, compatible_machine/process_expression_group,
//     print_compatible_printers), as PresetBundle::full_fff_config does (~3255–3545) without the
//     per-extruder variant expansion, which the engine applies from the *_extruder_variant keys.
//
// origin: BambuStudio src/libslic3r/Preset.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
import fs from 'node:fs';
import { AppError } from '../validation';
import { META_KEYS, VendorError, VendorProfiles, type VendorPreset } from './vendor';
import { ConditionError, evaluateCondition } from './condition';
import type { ProfilesLocation } from './locate';
import { TAB_GROUPS } from './groups.generated';
import { PRINTER_MODELS, type ModelCode } from '$lib/shared/printers/models';
import type {
	ConfigMap,
	ConfigValue,
	PresetRef,
	PresetSelection
} from '$lib/shared/slicer/project';
import type {
	PresetKind,
	PresetSummary,
	ProfileService,
	ResolvedBundle,
	ResolvedPreset,
	UserPreset
} from '$lib/shared/slicer/profiles';
import type { PresetKey, PresetPage } from '$lib/shared/slicer-profiles';

/** What the library needs from the user preset store. */
export interface UserPresetSource {
	list(kind?: PresetKind): UserPreset[];
	get(id: string): UserPreset | undefined;
	byName(kind: PresetKind, name: string): UserPreset | undefined;
}

const arr = (v: ConfigValue | undefined): string[] =>
	v === undefined ? [] : Array.isArray(v) ? v : v === '' ? [] : [v];
const first = (v: ConfigValue | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const same = (a: ConfigValue | undefined, b: ConfigValue | undefined) =>
	JSON.stringify(a) === JSON.stringify(b);

/** A child value over its parent's: "nil" slots of a vector take the parent's value. */
export function mergeValue(parent: ConfigValue | undefined, child: ConfigValue): ConfigValue {
	if (!Array.isArray(child) || !Array.isArray(parent)) return child;
	return child.map((v, i) => (v === 'nil' && parent[i] !== undefined ? parent[i] : v));
}

/** Nozzle sizes as preset variants spell them: "0.40" → "0.4". */
export function nozzleVariant(nozzle: string | number | null | undefined): string {
	const n = Number(nozzle);
	return Number.isFinite(n) && n > 0 ? String(n) : '0.4';
}

/** The <kind>_settings_id keys full_fff_config writes (never "different" settings). */
const SETTINGS_IDS: Record<PresetKind, string> = {
	printer: 'printer_settings_id',
	process: 'print_settings_id',
	filament: 'filament_settings_id'
};

/** Keys removed from the combined config (full_fff_config erases them). */
const BUNDLE_ERASED = [
	'compatible_prints',
	'compatible_prints_condition',
	'compatible_printers',
	'compatible_printers_condition',
	'inherits',
	'different_settings_to_system'
];

interface Printerish {
	name: string;
	config: ConfigMap;
	source: 'system' | 'user';
	inherits: string | null;
}

interface Candidate {
	summary: PresetSummary;
	config: ConfigMap;
}

const cache = new Map<
	string,
	{ mtime: number; vendor: VendorProfiles | null; error: string | null }
>();

export class ProfileLibrary implements ProfileService {
	constructor(
		private users: UserPresetSource,
		private where: () => ProfilesLocation | null
	) {}

	// ---------- Vendor set ----------

	private load(): {
		loc: ProfilesLocation;
		vendor: VendorProfiles | null;
		error: string | null;
	} | null {
		const loc = this.where();
		if (!loc) return null;
		let mtime: number;
		try {
			mtime = fs.statSync(`${loc.dir}/BBL.json`).mtimeMs;
		} catch {
			return null;
		}
		let hit = cache.get(loc.dir);
		if (!hit || hit.mtime !== mtime) {
			try {
				hit = { mtime, vendor: VendorProfiles.load(loc.dir), error: null };
			} catch (e) {
				hit = {
					mtime,
					vendor: null,
					error:
						e instanceof VendorError ? e.message : `Could not load presets: ${(e as Error).message}`
				};
			}
			cache.set(loc.dir, hit);
		}
		return { loc, vendor: hit.vendor, error: hit.error };
	}

	/** The system preset set, or null (see missing()). */
	vendorSet(): VendorProfiles | null {
		return this.load()?.vendor ?? null;
	}

	/** Why there are no system presets, in plain words; null when there are. */
	missing(): string | null {
		const l = this.load();
		if (!l)
			return 'Bambu Studio’s system presets are not on this computer yet. Run “bun run profiles:fetch” in the app folder, or install Bambu Studio.';
		return l.error;
	}

	private need(): VendorProfiles {
		const v = this.vendorSet();
		if (!v) throw new AppError(503, this.missing() ?? 'No system presets.');
		return v;
	}

	vendor(): { tag: string; version: string; dir: string } | null {
		const l = this.load();
		return l?.vendor ? { tag: l.loc.tag, version: l.vendor.version, dir: l.loc.dir } : null;
	}

	location(): ProfilesLocation | null {
		return this.load()?.loc ?? null;
	}

	// ---------- Resolving ----------

	private systemPreset(kind: PresetKind, name: string): VendorPreset {
		const p = this.need().get(kind, name);
		if (!p) throw new AppError(404, `There is no system ${kind} preset called “${name}”.`);
		return p;
	}

	userPreset(ref: PresetRef | string, kind?: PresetKind): UserPreset {
		const u =
			typeof ref === 'string'
				? this.users.get(ref)
				: ref.userPresetId
					? this.users.get(ref.userPresetId)
					: this.users.byName(ref.kind, ref.name);
		if (!u || (kind && u.kind !== kind) || (typeof ref !== 'string' && u.kind !== ref.kind))
			throw new AppError(404, 'That preset no longer exists.');
		return u;
	}

	/** A user preset over its system parent (a missing parent leaves its own keys only). */
	private resolveUser(u: UserPreset, strict: boolean): ResolvedPreset {
		let parent: VendorPreset | undefined;
		if (u.inherits) {
			parent = this.vendorSet()?.get(u.kind, u.inherits);
			if (!parent && strict)
				throw new AppError(
					409,
					`“${u.name}” is based on “${u.inherits}”, which these Bambu Studio presets do not have.`
				);
		}
		const config: ConfigMap = { ...(parent?.config ?? {}) };
		const origin: Record<string, string> = { ...(parent?.origin ?? {}) };
		for (const [k, v] of Object.entries(u.config)) {
			if (META_KEYS.has(k)) continue; // filament_id of a stand-alone filament preset
			config[k] = mergeValue(parent?.config[k], v);
			origin[k] = u.name;
		}
		return {
			kind: u.kind,
			name: u.name,
			chain: [u.name, ...(parent?.chain ?? [])],
			config,
			origin
		};
	}

	resolve(ref: PresetRef): ResolvedPreset {
		if (ref.source === 'project')
			throw new AppError(400, 'Presets saved in a project are read from the project file.');
		if (ref.source === 'user') return this.resolveUser(this.userPreset(ref), true);
		const p = this.systemPreset(ref.kind, ref.name);
		return { kind: p.kind, name: p.name, chain: p.chain, config: p.config, origin: p.origin };
	}

	/** The config a preset is compared against: a system preset's parent, a user preset's system preset. */
	private parentConfig(ref: PresetRef): ConfigMap | null {
		if (ref.source === 'user') {
			const u = this.userPreset(ref);
			return u.inherits ? (this.vendorSet()?.get(u.kind, u.inherits)?.config ?? null) : null;
		}
		const p = this.systemPreset(ref.kind, ref.name);
		return p.inherits ? (this.vendorSet()?.get(p.kind, p.inherits)?.config ?? null) : null;
	}

	diff(ref: PresetRef): { key: string; value: ConfigValue; parent: ConfigValue | null }[] {
		const resolved = this.resolve(ref);
		const parent = this.parentConfig(ref);
		const keys =
			ref.source === 'user'
				? Object.keys(this.userPreset(ref).config)
				: Object.keys(this.systemPreset(ref.kind, ref.name).own);
		return keys
			.filter((key) => !same(resolved.config[key], parent?.[key]))
			.sort()
			.map((key) => ({ key, value: resolved.config[key], parent: parent?.[key] ?? null }));
	}

	// ---------- Listing and compatibility ----------

	private systemSummary(p: VendorPreset): PresetSummary {
		return this.summaryOf(p.kind, p.name, 'system', p.name, p.inherits, p.instantiable, p.config, {
			filamentId: p.filamentId,
			settingId: p.settingId
		});
	}

	private summaryOf(
		kind: PresetKind,
		name: string,
		source: 'system' | 'user',
		id: string,
		inherits: string | null,
		instantiable: boolean,
		config: ConfigMap,
		ids: { filamentId?: string | null; settingId?: string | null }
	): PresetSummary {
		const s: PresetSummary = {
			kind,
			name,
			source,
			id,
			inherits,
			instantiable,
			compatiblePrinters: arr(config.compatible_printers),
			compatibleCondition: first(config.compatible_printers_condition) || null
		};
		if (kind === 'printer') {
			s.printerModel = first(config.printer_model);
			s.nozzle = first(config.printer_variant) || first(config.nozzle_diameter);
		}
		if (kind === 'filament') {
			s.filamentType = first(config.filament_type);
			if (ids.filamentId) s.filamentId = ids.filamentId;
		}
		if (ids.settingId) s.settingId = ids.settingId;
		return s;
	}

	private userSummary(u: UserPreset): Candidate {
		const r = this.resolveUser(u, false);
		const parent = u.inherits ? this.vendorSet()?.get(u.kind, u.inherits) : undefined;
		return {
			config: r.config,
			summary: this.summaryOf(u.kind, u.name, 'user', u.id, u.inherits, true, r.config, {
				filamentId: first(u.config.filament_id) || parent?.filamentId
			})
		};
	}

	private candidates(kind: PresetKind, hidden = false): Candidate[] {
		const system = (this.vendorSet()?.all(kind, hidden) ?? []).map((p) => ({
			summary: this.systemSummary(p),
			config: p.config
		}));
		return [...system, ...this.users.list(kind).map((u) => this.userSummary(u))];
	}

	private printerOf(ref: PresetRef): Printerish {
		const r = this.resolve(ref);
		return {
			name: r.name,
			config: r.config,
			source: ref.source === 'user' ? 'user' : 'system',
			inherits: ref.source === 'user' ? this.userPreset(ref).inherits : null
		};
	}

	/** Preset.cpp is_compatible_with_printer, for a preset's resolved config. */
	isCompatible(config: ConfigMap, printer: Printerish): boolean {
		const list = arr(config.compatible_printers);
		const condition = first(config.compatible_printers_condition);
		if (!list.length && condition) {
			try {
				return evaluateCondition(condition, printer.config, {
					printer_preset: printer.name,
					num_extruders: String(arr(printer.config.nozzle_diameter).length || 1)
				});
			} catch (e) {
				if (e instanceof ConditionError) return true; // upstream: "compatible with everything"
				throw e;
			}
		}
		return (
			!list.length ||
			list.includes(printer.name) ||
			(printer.source === 'user' && !!printer.inherits && list.includes(printer.inherits))
		);
	}

	compatible(printer: PresetRef, kind: 'process' | 'filament'): PresetSummary[] {
		const p = this.printerOf(printer);
		return this.candidates(kind)
			.filter((c) => this.isCompatible(c.config, p))
			.map((c) => c.summary);
	}

	/** The system printer preset for a model and nozzle ("Bambu Lab X1 Carbon 0.4 nozzle"). */
	printerFor(model: ModelCode, nozzle: string): VendorPreset {
		const m = PRINTER_MODELS[model];
		if (!m) throw new AppError(400, 'Unknown printer model.');
		const variant = nozzleVariant(nozzle);
		const found = this.need()
			.all('printer')
			.find(
				(p) =>
					first(p.config.printer_model) === m.name && first(p.config.printer_variant) === variant
			);
		if (!found)
			throw new AppError(
				422,
				`Bambu Studio has no ${variant} mm nozzle preset for the ${m.short}.`
			);
		return found;
	}

	list(
		kind: PresetKind,
		filter: { printer?: string; model?: ModelCode; nozzle?: string; includeHidden?: boolean } = {}
	): PresetSummary[] {
		const all = this.candidates(kind, filter.includeHidden);
		if (kind === 'printer') {
			const m = filter.model ? PRINTER_MODELS[filter.model] : null;
			return all
				.filter((c) => !m || first(c.config.printer_model) === m.name)
				.filter(
					(c) => !filter.nozzle || first(c.config.printer_variant) === nozzleVariant(filter.nozzle)
				)
				.map((c) => c.summary);
		}
		let printer: Printerish | null = null;
		if (filter.printer) {
			const user = this.users.byName('printer', filter.printer);
			printer = this.printerOf(
				user
					? { kind: 'printer', name: user.name, source: 'user', userPresetId: user.id }
					: { kind: 'printer', name: filter.printer, source: 'system' }
			);
		} else if (filter.model) {
			const p = this.printerFor(filter.model, filter.nozzle ?? '0.4');
			printer = { name: p.name, config: p.config, source: 'system', inherits: null };
		}
		return all
			.filter((c) => !printer || this.isCompatible(c.config, printer))
			.map((c) => c.summary);
	}

	// ---------- Defaults ----------

	/** The process preset nearest a layer height: "Standard" first, then "Balanced" (as slicer.ts picks). */
	pickProcess(processes: PresetSummary[], layer: number): PresetSummary | undefined {
		const byLayer = processes
			.map((p) => ({ p, h: Number(p.name.match(/^([\d.]+)mm/)?.[1] ?? NaN) }))
			.filter((x) => Number.isFinite(x.h))
			.sort((a, b) => Math.abs(a.h - layer) - Math.abs(b.h - layer));
		const nearest = byLayer.filter((x) => x.h === byLayer[0]?.h);
		return (
			nearest.find((x) => x.p.source === 'system' && /Standard/.test(x.p.name))?.p ??
			nearest.find((x) => x.p.source === 'system' && /Balanced/.test(x.p.name))?.p ??
			nearest[0]?.p
		);
	}

	/**
	 * The system filament preset closest to a material as written on a job ("PLA Matte", "PETG HF",
	 * "PLA-CF"): its filament_type as written, else the base type, else a type starting with it ("PA" →
	 * "PA6-CF"); Bambu's own presets first, then Generic ones (the A1 mini has no Bambu ABS, for one).
	 */
	pickFilament(filaments: PresetSummary[], material: string): PresetSummary | undefined {
		const wanted = (material || 'PLA').trim().toUpperCase();
		const type = wanted.match(/PLA|PETG|ABS|ASA|TPU|PCTG|PC|PA|PET|PVA|HIPS/)?.[0] ?? 'PLA';
		const words = wanted
			.replace(type, '')
			.split(/[^A-Z0-9]+/)
			.filter(Boolean);
		const score = (f: PresetSummary) =>
			words.filter((w) => f.name.toUpperCase().includes(w)).length * 10 +
			(/Basic/.test(f.name) ? 3 : 0) +
			(/ HF\b/.test(f.name) ? 2 : 0) -
			(/(CF|GF|Aero|Support|Silk|Glow|Marble|Sparkle|Metal|Galaxy|Wood|Translucent)/.test(f.name)
				? 5
				: 0);
		const system = filaments.filter((f) => f.source === 'system');
		const typeOf = (f: PresetSummary) => (f.filamentType ?? '').toUpperCase();
		const full = wanted.split(/\s+/)[0];
		for (const fits of [
			(f: PresetSummary) => typeOf(f) === full,
			(f: PresetSummary) => typeOf(f) === type,
			(f: PresetSummary) => typeOf(f).startsWith(type)
		])
			for (const vendor of [/^Bambu /, /^Generic /]) {
				const best = system
					.filter((f) => vendor.test(f.name) && fits(f))
					.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
				if (best) return best;
			}
		return undefined;
	}

	defaults(model: ModelCode, nozzle: string, material?: string): PresetSelection {
		const printer = this.printerFor(model, nozzle);
		const ref: PresetRef = { kind: 'printer', name: printer.name, source: 'system' };
		return { printer: ref, ...this.defaultsFor(ref, material) };
	}

	/**
	 * The default process and filament for any printer preset (a user one too): the printer's
	 * default_print_profile and default_filament_profile, else the model's default materials, else the
	 * nearest "Standard" 0.2 mm process and the closest filament to `material`.
	 */
	defaultsFor(
		printerRef: PresetRef,
		material?: string
	): { process: PresetRef; filaments: PresetRef[] } {
		return {
			process: this.defaultProcess(printerRef),
			filaments: [this.defaultFilament(printerRef, material)]
		};
	}

	defaultProcess(printerRef: PresetRef): PresetRef {
		const printer = this.resolve(printerRef);
		const processes = this.compatible(printerRef, 'process').filter((s) => s.source === 'system');
		const wanted = first(printer.config.default_print_profile);
		const process = processes.find((p) => p.name === wanted) ?? this.pickProcess(processes, 0.2);
		if (!process) throw new AppError(422, `Bambu Studio has no print preset for ${printer.name}.`);
		return { kind: 'process', name: process.name, source: 'system' };
	}

	defaultFilament(printerRef: PresetRef, material?: string): PresetRef {
		const printer = this.resolve(printerRef);
		const filaments = this.compatible(printerRef, 'filament').filter((s) => s.source === 'system');
		const byName = (names: string[]) =>
			names.map((n) => filaments.find((f) => f.name === n)).find(Boolean);
		const filament = material
			? this.pickFilament(filaments, material)
			: (byName(arr(printer.config.default_filament_profile)) ??
				byName(
					this.need().models.get(first(printer.config.printer_model))?.defaultMaterials ?? []
				) ??
				this.pickFilament(filaments, 'PLA'));
		if (!filament) {
			const short = Object.values(PRINTER_MODELS).find(
				(m) => m.name === first(printer.config.printer_model)
			)?.short;
			throw new AppError(
				422,
				`Bambu Studio has no ${material || 'PLA'} filament preset for ${short ? `the ${short}` : printer.name}.`
			);
		}
		return { kind: 'filament', name: filament.name, source: 'system' };
	}

	/** Whether a preset exists now (a user preset may be deleted, a system one gone after an update). */
	exists(ref: PresetRef): boolean {
		if (ref.source === 'user') {
			const u = ref.userPresetId
				? this.users.get(ref.userPresetId)
				: this.users.byName(ref.kind, ref.name);
			return u?.kind === ref.kind;
		}
		return ref.source === 'system' && !!this.vendorSet()?.get(ref.kind, ref.name)?.instantiable;
	}

	/** Whether a process or filament preset suits a printer preset (is_compatible_with_printer). */
	suits(ref: PresetRef, printer: PresetRef): boolean {
		return this.isCompatible(this.resolve(ref).config, this.printerOf(printer));
	}

	/** A filament preset for an AMS tray's tray_info_idx (Bambu filament_id), compatible with the printer. */
	filamentForTray(infoIdx: string, printer: PresetRef): PresetSummary | null {
		if (!infoIdx) return null;
		const matches = this.compatible(printer, 'filament').filter((f) => f.filamentId === infoIdx);
		return matches.find((f) => f.source === 'system') ?? matches[0] ?? null;
	}

	// ---------- Combining ----------

	private withOverrides(r: ResolvedPreset, over: ConfigMap | undefined): ResolvedPreset {
		if (!over || !Object.keys(over).length) return r;
		const config = { ...r.config };
		const origin = { ...r.origin };
		for (const [k, v] of Object.entries(over)) {
			config[k] = mergeValue(config[k], v);
			origin[k] = 'override';
		}
		return { ...r, config, origin };
	}

	/**
	 * Keys a preset (plus overrides) changes from its system preset, for different_settings_to_system:
	 * a system preset is compared with itself, a user preset with the system preset it inherits
	 * (get_selected_preset_parent, dirty_options_without_option_list with ignore_settings_list).
	 */
	private dirty(ref: PresetRef, resolved: ResolvedPreset, over: ConfigMap | undefined): string[] {
		let base: ConfigMap | null;
		let keys: string[];
		if (ref.source === 'user') {
			const u = this.userPreset(ref);
			base = u.inherits ? (this.vendorSet()?.get(u.kind, u.inherits)?.config ?? null) : null;
			keys = [...Object.keys(u.config), ...Object.keys(over ?? {})];
		} else {
			base = this.systemPreset(ref.kind, ref.name).config;
			keys = Object.keys(over ?? {});
		}
		const ignored = new Set(['inherits', ...Object.values(SETTINGS_IDS), ...META_KEYS]);
		return [...new Set(keys)]
			.filter((k) => !ignored.has(k) && !same(resolved.config[k], base?.[k]))
			.sort();
	}

	private inheritsOf(ref: PresetRef): string {
		return ref.source === 'user' ? (this.userPreset(ref).inherits ?? '') : '';
	}

	private filamentIdOf(ref: PresetRef): string {
		if (ref.source === 'system') return this.systemPreset('filament', ref.name).filamentId ?? '';
		const u = this.userPreset(ref);
		return (
			first(u.config.filament_id) ||
			(u.inherits ? (this.vendorSet()?.get('filament', u.inherits)?.filamentId ?? '') : '')
		);
	}

	bundle(
		selection: PresetSelection,
		overrides: { process?: ConfigMap; filaments?: ConfigMap[]; printer?: ConfigMap } = {}
	): ResolvedBundle {
		if (!selection.filaments.length) throw new AppError(400, 'Pick at least one filament.');
		const printer = this.withOverrides(this.resolve(selection.printer), overrides.printer);
		const process = this.withOverrides(this.resolve(selection.process), overrides.process);
		const filaments = selection.filaments.map((f, i) =>
			this.withOverrides(this.resolve(f), overrides.filaments?.[i])
		);
		const full: ConfigMap = { ...process.config, ...printer.config };
		if (filaments.length === 1) Object.assign(full, filaments[0].config);
		else {
			const keys = new Set(filaments.flatMap((f) => Object.keys(f.config)));
			for (const key of keys) {
				if (key === 'compatible_prints' || key === 'compatible_printers') continue;
				const values = filaments.map((f) => f.config[key]);
				const known = values.find((v) => v !== undefined)!;
				full[key] = Array.isArray(known)
					? values.flatMap((v) => arr(v ?? known))
					: first(values[0] ?? known);
			}
		}
		for (const k of BUNDLE_ERASED) delete full[k];
		full.print_settings_id = process.name;
		full.filament_settings_id = filaments.map((f) => f.name);
		full.printer_settings_id = printer.name;
		full.filament_ids = selection.filaments.map((f) => this.filamentIdOf(f));
		const someNonEmpty = (values: string[]) => values.some((v) => v !== '');
		const inherits = [
			this.inheritsOf(selection.process),
			...selection.filaments.map((f) => this.inheritsOf(f)),
			this.inheritsOf(selection.printer)
		];
		if (someNonEmpty(inherits)) full.inherits_group = inherits;
		const different = [
			this.dirty(selection.process, process, overrides.process).join(';'),
			...selection.filaments.map((f, i) =>
				this.dirty(f, filaments[i], overrides.filaments?.[i]).join(';')
			),
			this.dirty(selection.printer, printer, overrides.printer).join(';')
		];
		if (someNonEmpty(different)) full.different_settings_to_system = different;
		// The conditions of the print and filament presets, and the print preset's printer list.
		const condition = (r: ResolvedPreset, key: string) => first(r.config[key]);
		const machine = [process, ...filaments].map((r) =>
			condition(r, 'compatible_printers_condition')
		);
		if (someNonEmpty(machine)) full.compatible_machine_expression_group = machine;
		const prints = filaments.map((r) => condition(r, 'compatible_prints_condition'));
		if (someNonEmpty(prints)) full.compatible_process_expression_group = prints;
		const printPrinters = arr(process.config.compatible_printers);
		if (printPrinters.length) full.print_compatible_printers = printPrinters;
		const v = this.vendor();
		return {
			printer,
			process,
			filaments,
			full,
			vendor: { tag: v?.tag ?? 'unknown', version: v?.version ?? '' }
		};
	}

	// ---------- Editing user presets ----------

	/** Keys of `config` that differ from `parent` (what a user preset stores). */
	static diffAgainst(parent: ConfigMap | null, config: ConfigMap): ConfigMap {
		const out: ConfigMap = {};
		for (const [k, v] of Object.entries(config)) if (!same(parent?.[k], v)) out[k] = v;
		return out;
	}

	/**
	 * What a new user preset stores: from a system preset it inherits that preset; from a user preset it
	 * keeps that preset's system parent and its changes (Bambu Studio's "Save as").
	 */
	derive(
		kind: PresetKind,
		name: string,
		from: PresetRef | null,
		config: ConfigMap
	): { inherits: string | null; config: ConfigMap } {
		if (this.vendorSet()?.get(kind, name))
			throw new AppError(409, `“${name}” is the name of a system preset. Pick another name.`);
		if (!from) return { inherits: null, config };
		if (from.kind !== kind) throw new AppError(400, `Pick a ${kind} preset to start from.`);
		if (from.source === 'user') {
			const u = this.userPreset(from);
			const parent = u.inherits ? (this.vendorSet()?.get(kind, u.inherits)?.config ?? null) : null;
			return {
				inherits: u.inherits,
				config: ProfileLibrary.diffAgainst(parent, { ...u.config, ...config })
			};
		}
		const parent = this.systemPreset(kind, from.name);
		if (!parent.instantiable)
			throw new AppError(400, `“${from.name}” is a base preset; start from one you can select.`);
		return { inherits: parent.name, config: ProfileLibrary.diffAgainst(parent.config, config) };
	}

	/** The stored keys after an edit: only what differs from the system parent. */
	normalise(u: UserPreset, config: ConfigMap): ConfigMap {
		const parent = u.inherits ? (this.vendorSet()?.get(u.kind, u.inherits)?.config ?? null) : null;
		return ProfileLibrary.diffAgainst(parent, config);
	}

	/** A preset's keys grouped like Bambu Studio's tabs, with what it changes from its parent. */
	pages(ref: PresetRef): PresetPage[] {
		const r = this.resolve(ref);
		const parent = this.parentConfig(ref);
		const changed = new Set(this.diff(ref).map((d) => d.key));
		const entry = (key: string): PresetKey => ({
			key,
			value: r.config[key],
			parent: changed.has(key) ? (parent?.[key] ?? null) : null,
			origin: r.origin[key] ?? r.name,
			changed: changed.has(key)
		});
		const placed = new Set<string>();
		const pages: PresetPage[] = [];
		for (const tab of TAB_GROUPS[r.kind]) {
			const groups = tab.groups
				.map((g) => ({
					group: g.group,
					keys: g.keys.filter((k) => k in r.config).map((k) => (placed.add(k), entry(k)))
				}))
				.filter((g) => g.keys.length);
			if (groups.length) pages.push({ page: tab.page, groups });
		}
		const rest = Object.keys(r.config)
			.filter((k) => !placed.has(k))
			.sort();
		if (rest.length)
			pages.push({
				page: 'Other',
				groups: [{ group: 'All other settings', keys: rest.map(entry) }]
			});
		return pages;
	}
}
