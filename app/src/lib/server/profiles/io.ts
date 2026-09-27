// Importing and exporting user presets in Bambu Studio's own formats, so presets move both ways:
//   - a preset .json as Preset::save / ConfigBase::save_to_json write it: "version", "name",
//     "from": "User", "inherits", the changed keys, and <kind>_settings_id, which is how
//     PresetBundle::import_json_presets tells the kind (printer_settings_id, print_settings_id,
//     filament_settings_id) (src/libslic3r/Config.cpp ~1521, PresetBundle.cpp ~1090–1200);
//   - a printer bundle .bbscfg: a zip of printer/, filament/ and process/ preset files plus
//     bundle_structure.json ("bundle_type": "printer config bundle", printer_preset_name,
//     printer_config, filament_config, process_config) (src/slic3r/GUI/CreatePresetsDialog.cpp
//     ExportConfigsDialog::archive_preset_bundle_to_file ~4050);
//   - a filament bundle .bbsflmt: <vendor>/<preset>.json per preset plus bundle_structure.json
//     ("filament config bundle", filament_name, filament_vendor: [{vendor, filament_path}]) (~4170).
// Import reads either, like import_presets: every .json in a zip except bundle_structure.json. A preset
// without a version, of unknown kind, named like a system preset, or based on a system preset these
// profiles lack is skipped, as upstream skips it; one named like an existing user preset replaces it.
//
// origin: BambuStudio src/libslic3r/Config.cpp, src/slic3r/GUI/CreatePresetsDialog.cpp @
//   926a7192574bcb9b3a732e1ec59a46d79cb45466
import { readZip, writeZip } from '../cad/mesh';
import { AppError } from '../validation';
import { META_KEYS } from './vendor';
import { ProfileLibrary } from './library';
import type { UserPresetStore } from './store';
import type { ConfigMap, ConfigValue } from '$lib/shared/slicer/project';
import type { PresetKind, UserPreset } from '$lib/shared/slicer/profiles';

const SETTINGS_ID: Record<PresetKind, string> = {
	printer: 'printer_settings_id',
	process: 'print_settings_id',
	filament: 'filament_settings_id'
};
/** Written by Bambu Studio beside the config; not settings. */
const USER_META = new Set([
	'base_id',
	'user_id',
	'updated_time',
	'print_settings_id',
	'printer_settings_id',
	'filament_settings_id'
]);
export const BUNDLE_STRUCTURE = 'bundle_structure.json';
const MAX_FILES = 200;
/** One preset file, unpacked (G-code templates make the biggest ones about 100 kB). */
const MAX_PRESET_BYTES = 4 * 1024 * 1024;

/** "v02.08.02.61" → "02.08.02.61" (the version field Bambu Studio checks with Semver::parse). */
export const versionOf = (tag: string) =>
	tag.replace(/^v/, '').match(/^\d+\.\d+\.\d+(\.\d+)?/)?.[0] ?? '02.00.00.00';

/** One user preset as Bambu Studio's user preset .json. */
export function presetJson(u: UserPreset, tag: string): Record<string, ConfigValue> {
	const out: Record<string, ConfigValue> = {
		version: versionOf(tag),
		name: u.name,
		from: 'User',
		inherits: u.inherits ?? '',
		[SETTINGS_ID[u.kind]]: u.kind === 'filament' ? [u.name] : u.name
	};
	for (const [k, v] of Object.entries(u.config)) if (!(k in out)) out[k] = v;
	return out;
}

/** A preset name as a file name: characters no file system takes become "_". */
// eslint-disable-next-line no-control-regex
export const safeName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
const fileName = (name: string) => `${safeName(name)}.json`;
/** Names Bambu Studio could not save as a file. */
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\u0000-\u001f\\/]/;

export interface ImportResult {
	imported: { id: string; kind: PresetKind; name: string; replaced: boolean }[];
	skipped: { name: string; reason: string }[];
}

type Json = Record<string, unknown>;

function toValue(v: unknown): ConfigValue | undefined {
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	if (Array.isArray(v) && v.length <= 64)
		return v.map((x) => (Array.isArray(x) ? x.map(String).join(',') : String(x)));
	return undefined;
}

/** Reads a preset .json, a .bbscfg/.bbsflmt/.zip bundle, and stores what it holds. */
export function importPresets(
	lib: ProfileLibrary,
	store: UserPresetStore,
	file: { name: string; data: Buffer }
): ImportResult {
	const result: ImportResult = { imported: [], skipped: [] };
	const docs: { file: string; json: unknown }[] = [];
	const isZip = file.data.subarray(0, 2).toString('latin1') === 'PK';
	if (isZip) {
		let entries: Map<string, Buffer>;
		let count = 0;
		try {
			// Counted while listing, and each file capped, so a small zip cannot unpack into gigabytes.
			entries = readZip(
				file.data,
				(n) => (/\.json$/i.test(n) ? (++count > MAX_FILES ? false : 'all') : false),
				Infinity,
				MAX_PRESET_BYTES
			);
		} catch {
			throw new AppError(400, 'That bundle could not be read.');
		}
		if (count > MAX_FILES) throw new AppError(413, 'That bundle holds too many presets.');
		for (const [name, data] of entries) {
			if (name.split('/').pop() === BUNDLE_STRUCTURE) continue;
			try {
				docs.push({ file: name, json: JSON.parse(data.toString('utf8')) });
			} catch {
				result.skipped.push({ name, reason: 'Not valid JSON.' });
			}
		}
	} else {
		try {
			docs.push({ file: file.name, json: JSON.parse(file.data.toString('utf8')) });
		} catch {
			throw new AppError(
				400,
				'That file is not a Bambu Studio preset (.json, .bbscfg or .bbsflmt).'
			);
		}
	}
	const vendor = lib.vendorSet();
	for (const doc of docs) {
		const j = doc.json as Json;
		const name = typeof j?.name === 'string' ? j.name.trim() : '';
		const label = name || doc.file;
		if (!j || typeof j !== 'object' || Array.isArray(j) || !name) {
			result.skipped.push({ name: label, reason: 'Not a preset.' });
			continue;
		}
		if (name.length > 120 || BAD_NAME.test(name)) {
			result.skipped.push({ name: label, reason: 'The name is too long or has / or \\ in it.' });
			continue;
		}
		if (typeof j.version !== 'string' || !/^\d+\.\d+\.\d+/.test(j.version)) {
			result.skipped.push({ name: label, reason: 'It has no version.' });
			continue;
		}
		const kind = (Object.keys(SETTINGS_ID) as PresetKind[]).find((k) => SETTINGS_ID[k] in j);
		if (!kind) {
			result.skipped.push({ name: label, reason: 'Not a printer, process or filament preset.' });
			continue;
		}
		if (vendor?.get(kind, name)) {
			result.skipped.push({ name: label, reason: 'A system preset has that name.' });
			continue;
		}
		const inherits = typeof j.inherits === 'string' && j.inherits ? j.inherits : null;
		const parent = inherits ? vendor?.get(kind, inherits) : undefined;
		if (inherits && !parent) {
			result.skipped.push({
				name: label,
				reason: `It is based on “${inherits}”, which these Bambu Studio presets do not have.`
			});
			continue;
		}
		const config: ConfigMap = {};
		for (const [k, v] of Object.entries(j)) {
			if ((META_KEYS.has(k) && k !== 'filament_id') || USER_META.has(k)) continue;
			if (!/^[a-z][a-z0-9_]{0,99}$/.test(k)) continue;
			const value = toValue(v);
			if (value !== undefined) config[k] = value;
		}
		const { preset, replaced } = store.upsert({
			kind,
			name,
			inherits,
			config: ProfileLibrary.diffAgainst(parent?.config ?? null, config)
		});
		result.imported.push({ id: preset.id, kind, name, replaced });
	}
	if (!result.imported.length && !result.skipped.length)
		throw new AppError(400, 'No presets found in that file.');
	return result;
}

const stamp = () => {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * A printer bundle (.bbscfg) for a user printer preset, with the user process and filament presets
 * that suit it, laid out as Bambu Studio exports one.
 */
export function printerBundle(
	lib: ProfileLibrary,
	store: UserPresetStore,
	printer: UserPreset,
	tag: string
): Buffer {
	const ref = {
		kind: 'printer' as const,
		name: printer.name,
		source: 'user' as const,
		userPresetId: printer.id
	};
	const entries: [string, Buffer][] = [];
	const add = (dir: string, u: UserPreset) => {
		const path = `${dir}/${fileName(u.name)}`;
		entries.push([path, Buffer.from(JSON.stringify(presetJson(u, tag), null, 4))]);
		return path;
	};
	const printerConfig = [add('printer', printer)];
	const suits = (kind: 'process' | 'filament') => {
		const ids = new Set(
			lib
				.compatible(ref, kind)
				.filter((s) => s.source === 'user')
				.map((s) => s.id)
		);
		return store.list(kind).filter((u) => ids.has(u.id));
	};
	const filamentConfig = suits('filament').map((u) => add('filament', u));
	const processConfig = suits('process').map((u) => add('process', u));
	const structure = {
		version: '',
		bundle_id: `offline_${printer.name}_${stamp()}`,
		bundle_type: 'printer config bundle',
		printer_preset_name: printer.name,
		printer_config: printerConfig,
		filament_config: filamentConfig,
		process_config: processConfig
	};
	entries.push([BUNDLE_STRUCTURE, Buffer.from(JSON.stringify(structure, null, 4))]);
	return writeZip(entries);
}

/** The filament name a preset belongs to: its name before " @" (Bambu Studio's alias). */
export const filamentName = (name: string) => name.split('@')[0].trim() || name;

/** A filament bundle (.bbsflmt): every user filament preset with the same filament name. */
export function filamentBundle(
	lib: ProfileLibrary,
	store: UserPresetStore,
	filament: UserPreset,
	tag: string
): Buffer {
	const alias = filamentName(filament.name);
	const byVendor = new Map<string, string[]>();
	const entries: [string, Buffer][] = [];
	for (const u of store.list('filament').filter((x) => filamentName(x.name) === alias)) {
		const r = lib.resolve({ kind: 'filament', name: u.name, source: 'user', userPresetId: u.id });
		const v = r.config.filament_vendor;
		// The vendor names a folder in the zip: no path separators or dot-only names.
		const vendor = safeName((Array.isArray(v) ? v[0] : v) || '').replace(/^\.+$/, '_') || 'Generic';
		const path = `${vendor}/${fileName(u.name)}`;
		entries.push([path, Buffer.from(JSON.stringify(presetJson(u, tag), null, 4))]);
		byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), path]);
	}
	const structure = {
		version: '',
		bundle_id: `offline_${alias}_${stamp()}`,
		bundle_type: 'filament config bundle',
		filament_name: alias,
		filament_vendor: [...byVendor].map(([vendor, paths]) => ({ vendor, filament_path: paths }))
	};
	entries.push([BUNDLE_STRUCTURE, Buffer.from(JSON.stringify(structure, null, 4))]);
	return writeZip(entries);
}
