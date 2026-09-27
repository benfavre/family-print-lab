// Bambu Studio's system presets (a vendor folder: BBL.json plus BBL/machine, process, filament), loaded
// and resolved the way upstream's PresetBundle::load_vendor_configs_from_json does at the tag in
// slicer/upstream.lock (src/libslic3r/PresetBundle.cpp ~4620–5430, Config.cpp load_from_json ~848):
//   - BBL.json lists machine_model_list, process_list, filament_list and machine_list (name + sub_path);
//     each kind is loaded in list order into its own name → config map, so a parent must come first;
//   - a preset starts from its `inherits` parent (a missing parent fails the vendor, as upstream), then
//     applies the keys of each `include` entry, then its own keys;
//   - `instantiation: "false"` presets are bases: kept for inheritance, not selectable. A nameless or
//     "gcode" named non-instantiable file is a pure include (its own keys only, under its list name);
//   - filament presets inherit `filament_id` from their parent, and one without it is an error;
//   - a printer preset whose printer_model is not a listed model, or whose printer_variant is not one of
//     that model's nozzle_diameter variants, fails the whole vendor upstream (its "will be ignored" log
//     line is followed by a ConfigurationError). Here it is dropped with a warning instead, so one odd
//     file in PRINTLAB_PROFILES_DIR does not hide every preset; the pinned BBL set has none.
//   - names already in the name → config map keep their first definition (std::map::emplace).
// Keys no preset in the chain sets keep the engine's built-in defaults (libslic3r's PrintConfigDef),
// which are not modelled here; everything a system preset writes is. "nil" array entries are kept as
// they are: the slicer reads them as "use the printer's value".
//
// origin: BambuStudio src/libslic3r/PresetBundle.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigMap, ConfigValue } from '$lib/shared/slicer/project';
import type { PresetKind } from '$lib/shared/slicer/profiles';

/** Keys load_from_json keeps out of the config (Preset.hpp BBL_JSON_KEY_*). */
export const META_KEYS = new Set([
	'version',
	'is_custom',
	'name',
	'url',
	'type',
	'setting_id',
	'filament_id',
	'from',
	'description',
	'instantiation',
	'inherits',
	'include'
]);

const LISTS: Record<PresetKind, string> = {
	process: 'process_list',
	filament: 'filament_list',
	printer: 'machine_list'
};

export interface PrinterModelEntry {
	/** "Bambu Lab X1 Carbon". */
	name: string;
	/** model_id, e.g. "BL-P001". */
	modelId: string;
	/** nozzle_diameter variants, e.g. ["0.4", "0.2", "0.6", "0.8"]. */
	variants: string[];
	defaultMaterials: string[];
	defaultBedType: string;
	/** Cover picture in the vendor folder, if present. */
	cover: string | null;
}

export interface VendorPreset {
	kind: PresetKind;
	name: string;
	inherits: string | null;
	/** From the preset up to the root. */
	chain: string[];
	config: ConfigMap;
	origin: Record<string, string>;
	/** The keys the preset's own file sets (the diff against its parent). */
	own: ConfigMap;
	instantiable: boolean;
	settingId: string | null;
	filamentId: string | null;
	description: string;
}

interface Entry {
	config: ConfigMap;
	origin: Record<string, string>;
	chain: string[];
}

/** A vendor folder could not be loaded; `file` names the preset file at fault. */
export class VendorError extends Error {
	constructor(
		message: string,
		readonly file?: string
	) {
		super(message);
	}
}

type Json = Record<string, unknown>;

/** A JSON value as a config value: strings stay, string arrays stay (nested arrays joined with "#"). */
function toValue(v: unknown): ConfigValue | undefined {
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	if (Array.isArray(v))
		return v.map((x) => (Array.isArray(x) ? x.map(String).join(',') : String(x)));
	return undefined;
}

function ownConfig(data: Json): ConfigMap {
	const out: ConfigMap = {};
	for (const [key, value] of Object.entries(data)) {
		if (META_KEYS.has(key)) continue;
		const v = toValue(value);
		if (v !== undefined) out[key] = v;
	}
	return out;
}

/** `include` as upstream reads it: a string or an array of strings. */
function includes(data: Json): string[] {
	const inc = data.include;
	if (typeof inc === 'string') return inc ? [inc] : [];
	if (Array.isArray(inc)) return inc.filter((x): x is string => typeof x === 'string');
	return [];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export class VendorProfiles {
	readonly name: string;
	/** BBL.json version, e.g. "02.08.00.05". */
	readonly version: string;
	readonly models = new Map<string, PrinterModelEntry>();
	/** Problems that did not stop the load (dropped printers). */
	readonly warnings: string[] = [];
	private presets: Record<PresetKind, Map<string, VendorPreset>> = {
		printer: new Map(),
		process: new Map(),
		filament: new Map()
	};

	private constructor(
		readonly dir: string,
		readonly vendor: string,
		root: Json
	) {
		this.name = str(root.name) || vendor;
		this.version = str(root.version);
		this.loadModels(root);
		for (const kind of ['process', 'filament', 'printer'] as PresetKind[])
			this.loadKind(kind, root);
	}

	/** Loads `<dir>/<vendor>.json` and `<dir>/<vendor>/`. Throws VendorError like upstream would. */
	static load(dir: string, vendor = 'BBL'): VendorProfiles {
		const file = path.join(dir, `${vendor}.json`);
		let root: Json;
		try {
			root = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
		} catch (e) {
			throw new VendorError(`Could not read ${file}: ${(e as Error).message}`, file);
		}
		if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(str(root.version)))
			throw new VendorError(`${file} has no valid version.`, file);
		return new VendorProfiles(dir, vendor, root);
	}

	private list(root: Json, key: string): { name: string; subPath: string }[] {
		const items = Array.isArray(root[key]) ? (root[key] as Json[]) : [];
		return items
			.map((i) => ({ name: str(i?.name), subPath: str(i?.sub_path) }))
			.filter((i) => i.name && i.subPath);
	}

	private read(subPath: string): Json {
		const file = path.join(this.dir, this.vendor, subPath);
		const rel = path.relative(path.join(this.dir, this.vendor), file);
		if (rel.startsWith('..') || path.isAbsolute(rel))
			throw new VendorError(`Preset path outside the vendor folder: ${subPath}`, subPath);
		try {
			return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
		} catch (e) {
			throw new VendorError(`Failed loading configuration file ${file}: ${(e as Error).message}`);
		}
	}

	private loadModels(root: Json) {
		for (const item of this.list(root, 'machine_model_list')) {
			const file = path.join(this.dir, this.vendor, item.subPath);
			if (!fs.existsSync(file)) continue; // upstream logs and skips
			const m = this.read(item.subPath);
			const variants = str(m.nozzle_diameter)
				.split(';')
				.map((v) => v.trim())
				.filter(Boolean);
			if (!variants.length) continue;
			const coverFile = `${item.name}_cover.png`;
			this.models.set(item.name, {
				name: item.name,
				modelId: str(m.model_id),
				variants,
				defaultMaterials: str(m.default_materials).split(';').filter(Boolean),
				defaultBedType: str(m.default_bed_type),
				cover: fs.existsSync(path.join(this.dir, this.vendor, coverFile)) ? coverFile : null
			});
		}
	}

	private loadKind(kind: PresetKind, root: Json) {
		const maps = new Map<string, Entry>();
		const filamentIds = new Map<string, string>();
		const descriptions = new Map<string, string>();
		for (const item of this.list(root, LISTS[kind])) {
			const data = this.read(item.subPath);
			const name = str(data.name);
			const instantiation = str(data.instantiation);
			let filamentId = str(data.filament_id);
			let description = '';
			const inherits = str(data.inherits);
			let base: Entry = { config: {}, origin: {}, chain: [] };
			if (inherits) {
				const parent = maps.get(inherits);
				if (!parent)
					throw new VendorError(
						`Failed loading configuration file ${item.subPath}: can not find inherits ${inherits}.`,
						item.subPath
					);
				base = parent;
				if (!filamentId && kind === 'filament') filamentId = filamentIds.get(inherits) ?? '';
				description = descriptions.get(inherits) ?? '';
			}
			const own = ownConfig(data);
			const config: ConfigMap = { ...base.config };
			const origin: Record<string, string> = { ...base.origin };
			for (const inc of includes(data)) {
				const included = maps.get(inc);
				if (!included) {
					this.warnings.push(`${name}: can not find include ${inc}.`);
					continue;
				}
				for (const [k, v] of Object.entries(included.config)) {
					config[k] = v;
					origin[k] = included.origin[k] ?? inc;
				}
			}
			if (typeof data.description === 'string') description = data.description;
			if (description && !descriptions.has(name)) descriptions.set(name, description);
			for (const [k, v] of Object.entries(own)) {
				config[k] = v;
				origin[k] = name || item.name;
			}
			const pureInclude = !name || name.includes('gcode');
			if (instantiation === 'false' || (!instantiation && pureInclude)) {
				if (pureInclude) {
					// Pure included file: its own keys only, under its list name.
					const byOwn: Record<string, string> = {};
					for (const k of Object.keys(own)) byOwn[k] = item.name;
					if (!maps.has(item.name))
						maps.set(item.name, { config: own, origin: byOwn, chain: [item.name] });
					continue;
				}
				if (!maps.has(name)) maps.set(name, { config, origin, chain: [name, ...base.chain] });
				if (kind === 'filament' && filamentId && !filamentIds.has(name))
					filamentIds.set(name, filamentId);
				this.presets[kind].set(name, {
					kind,
					name,
					inherits: inherits || null,
					chain: [name, ...base.chain],
					config,
					origin,
					own,
					instantiable: false,
					settingId: str(data.setting_id) || null,
					filamentId: filamentId || null,
					description
				});
				continue;
			}
			if (kind === 'printer') {
				const model = str(config.printer_model);
				const variant = str(config.printer_variant);
				const entry = this.models.get(model);
				if (!model || !variant || !entry || !entry.variants.includes(variant)) {
					this.warnings.push(
						`${name}: printer model "${model}" variant "${variant}" is not in the vendor profile; ignored.`
					);
					continue;
				}
			}
			if (this.presets[kind].get(name)?.instantiable)
				throw new VendorError(`${name} is defined twice.`, item.subPath);
			if (kind === 'filament') {
				if (!filamentId)
					throw new VendorError(`Can not find filament_id for ${name}.`, item.subPath);
				if (!filamentIds.has(name)) filamentIds.set(name, filamentId);
			}
			const chain = [name, ...base.chain];
			if (!maps.has(name)) maps.set(name, { config, origin, chain });
			this.presets[kind].set(name, {
				kind,
				name,
				inherits: inherits || null,
				chain,
				config,
				origin,
				own,
				instantiable: true,
				settingId: str(data.setting_id) || null,
				filamentId: filamentId || null,
				description
			});
		}
	}

	get(kind: PresetKind, name: string): VendorPreset | undefined {
		return this.presets[kind].get(name);
	}

	/** Every preset of a kind in list order; bases (non-instantiable) only with `hidden`. */
	all(kind: PresetKind, hidden = false): VendorPreset[] {
		const out = [...this.presets[kind].values()];
		return hidden ? out : out.filter((p) => p.instantiable);
	}

	/** Every compatible_printers_condition / compatible_prints_condition string in the set. */
	conditions(): string[] {
		const out = new Set<string>();
		for (const kind of ['process', 'filament', 'printer'] as PresetKind[])
			for (const p of this.presets[kind].values())
				for (const key of ['compatible_printers_condition', 'compatible_prints_condition']) {
					const v = p.config[key];
					if (typeof v === 'string') out.add(v);
				}
		return [...out];
	}
}
