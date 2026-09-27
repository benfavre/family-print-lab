// Bambu Studio's system profiles as the stock command line needs them: the CLI only accepts complete
// presets, and the files in resources/profiles/BBL inherit from each other, so they are flattened here
// first (child keys win, as PresetBundle does when it loads them). Also picks the presets closest to a
// job's settings. slicer-profiles is the full implementation (user presets, compatibility conditions);
// this is the small part the CLI backend cannot do without.
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../validation';
import { PRINTER_MODELS, type ModelCode } from '$lib/shared/printers/models';
import type { ConfigMap, ConfigValue, PresetSelection } from '$lib/shared/slicer/project';
import type {
	PresetKind,
	PresetSummary,
	ResolvedBundle,
	ResolvedPreset
} from '$lib/shared/slicer/profiles';

type Profile = Record<string, unknown> & { name: string; inherits?: string };
/** Bambu Studio's folder names under profiles/BBL. */
type Dir = 'machine' | 'process' | 'filament';
export const DIR: Record<PresetKind, Dir> = {
	printer: 'machine',
	process: 'process',
	filament: 'filament'
};

/** Keys that describe a preset file rather than its settings (filament_id and setting_id stay). */
const META_KEYS = new Set(['inherits', 'instantiation', 'from', 'type']);

function* walk(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.name.endsWith('.json')) yield full;
	}
}

const text = (v: unknown): ConfigValue =>
	Array.isArray(v) ? v.map((x) => String(x)) : typeof v === 'string' ? v : JSON.stringify(v);

/** Profiles of one Bambu Studio resources folder, indexed by kind and name (loaded once). */
export class ProfileBook {
	private byName = new Map<string, Profile>();
	/** Machine model name ("Bambu Lab X2D") → model_id ("N6"), from the machine model files. */
	readonly modelIds = new Map<string, string>();
	/** BBL.json "version" (the vendor profile version), or "" when missing. */
	readonly version: string;

	/** `root` is <resources>/profiles/BBL. */
	constructor(readonly root: string) {
		for (const dir of ['machine', 'process', 'filament'] as Dir[]) {
			const folder = path.join(root, dir);
			if (!fs.existsSync(folder)) continue;
			for (const file of walk(folder)) {
				try {
					const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Profile;
					if (typeof p.name !== 'string') continue;
					this.byName.set(`${dir}:${p.name}`, p);
					if (dir === 'machine' && typeof p.model_id === 'string')
						this.modelIds.set(p.name, p.model_id);
				} catch {
					/* skip unreadable files */
				}
			}
		}
		let version = '';
		try {
			version = String(JSON.parse(fs.readFileSync(`${root}.json`, 'utf8')).version ?? '');
		} catch {
			/* no BBL.json */
		}
		this.version = version;
	}

	has(kind: PresetKind, name: string) {
		return this.byName.has(`${DIR[kind]}:${name}`);
	}

	/** A profile with everything it inherits merged in, as the command line needs it. */
	flat(kind: PresetKind, name: string): Profile {
		const own = this.byName.get(`${DIR[kind]}:${name}`);
		if (!own) throw new AppError(500, `Bambu Studio has no ${DIR[kind]} profile “${name}”.`);
		const base = own.inherits ? this.flat(kind, own.inherits) : {};
		const out = { ...base, ...own } as Profile;
		delete out.inherits;
		return out;
	}

	/** The preset resolved through its parents, with the preset that set each key. */
	resolve(kind: PresetKind, name: string): ResolvedPreset {
		const chain: string[] = [];
		for (let at: string | undefined = name; at;) {
			const p = this.byName.get(`${DIR[kind]}:${at}`);
			if (!p) throw new AppError(422, `Bambu Studio has no ${DIR[kind]} profile “${at}”.`);
			if (chain.includes(at)) break;
			chain.push(at);
			at = p.inherits || undefined;
		}
		const config: ConfigMap = {};
		const origin: Record<string, string> = {};
		for (const at of [...chain].reverse()) {
			const p = this.byName.get(`${DIR[kind]}:${at}`)!;
			for (const [key, value] of Object.entries(p)) {
				if (key === 'name' || META_KEYS.has(key)) continue;
				config[key] = text(value);
				origin[key] = at;
			}
		}
		return { kind, name, chain, config, origin };
	}

	/** Every preset of a kind, as the protocol lists them. */
	list(kind: PresetKind): PresetSummary[] {
		const out: PresetSummary[] = [];
		for (const [key, p] of this.byName) {
			if (!key.startsWith(`${DIR[kind]}:`)) continue;
			const flat = () => this.flat(kind, p.name);
			const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : undefined);
			out.push({
				kind,
				name: p.name,
				source: 'system',
				id: p.name,
				inherits: p.inherits ?? null,
				instantiable: p.instantiation !== 'false',
				compatiblePrinters: Array.isArray(p.compatible_printers)
					? p.compatible_printers.map(String)
					: [],
				compatibleCondition:
					typeof p.compatible_printers_condition === 'string'
						? p.compatible_printers_condition
						: null,
				...(kind === 'printer' && p.instantiation !== 'false'
					? {
							printerModel: String(flat().printer_model ?? ''),
							nozzle: first(flat().nozzle_diameter)
						}
					: {}),
				...(kind === 'filament' && p.instantiation !== 'false'
					? {
							filamentType: first(flat().filament_type),
							filamentId: typeof p.filament_id === 'string' ? p.filament_id : undefined
						}
					: {}),
				...(typeof p.setting_id === 'string' ? { settingId: p.setting_id } : {})
			});
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Leaf (selectable) profiles of a kind that list this machine as compatible. */
	compatible(kind: 'process' | 'filament', machine: string): Profile[] {
		const out: Profile[] = [];
		for (const [key, p] of this.byName) {
			if (!key.startsWith(`${kind}:`) || p.instantiation === 'false') continue;
			const list = p.compatible_printers;
			if (Array.isArray(list) && list.includes(machine)) out.push(p);
		}
		return out;
	}

	/**
	 * Printer, process and filaments resolved, plus the flat config the slicer consumes. `full` combines
	 * them the way PresetBundle::full_fff_config does for the common case: printer and process keys as
	 * they are, per-filament keys as one array entry per filament (each filament's first value).
	 */
	bundle(selection: PresetSelection, tag: string): ResolvedBundle {
		const printer = this.resolve('printer', selection.printer.name);
		const process = this.resolve('process', selection.process.name);
		const filaments = selection.filaments.map((f) => this.resolve('filament', f.name));
		return {
			printer,
			process,
			filaments,
			full: combine(
				printer.config,
				process.config,
				filaments.map((f) => f.config)
			),
			vendor: { tag, version: this.version }
		};
	}
}

/** printer + process + one entry per filament for per-filament keys. */
export function combine(printer: ConfigMap, process: ConfigMap, filaments: ConfigMap[]): ConfigMap {
	const full: ConfigMap = { ...printer, ...process };
	const keys = new Set(filaments.flatMap((f) => Object.keys(f)));
	for (const key of keys)
		full[key] = filaments.map((f) => {
			const v = f[key];
			return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
		});
	return full;
}

const books = new Map<string, ProfileBook>();

/** The profile book of a resources folder (its profiles are at <resources>/profiles/BBL); cached. */
export function profileBook(resources: string): ProfileBook {
	const root = path.join(resources, 'profiles', 'BBL');
	let b = books.get(root);
	if (!b) books.set(root, (b = new ProfileBook(root)));
	return b;
}

export interface SliceSettings {
	/** The printer model to slice for (its Bambu Studio machine preset). */
	model: ModelCode;
	/** Nozzle size, e.g. "0.4". */
	nozzle: string;
	/** Layer height in mm, e.g. "0.20". */
	layerHeight: string;
	/** Material as written on the job, e.g. "PLA Matte", "PETG". */
	material: string;
	supports: 'None' | 'Normal' | 'Tree';
	/** Percent, or null for the profile's default. */
	infill: number | null;
	/** Build plate as written on the job, e.g. "Textured PEI". */
	plate: string;
	/** Filament colour (#RRGGBB) from the job's spool, if known. */
	color?: string | null;
}

export interface SliceChoice {
	machine: string;
	process: string;
	filament: string;
	bedType: string;
}

/**
 * Job plate words → Bambu Studio curr_bed_type values (PrintConfig.cpp s_keys_map_BedType); the first
 * match wins, so "Cool Plate SuperTack" is the SuperTack and a plain cool plate is the Cool Plate.
 */
const BED_TYPES: Record<string, string> = {
	supertack: 'Supertack Plate',
	'textured pei': 'Textured PEI Plate',
	'smooth pei': 'High Temp Plate',
	'high temp': 'High Temp Plate',
	engineering: 'Engineering Plate',
	'cool plate': 'Cool Plate'
};

export function bedTypeFor(plate: string): string {
	const key = Object.keys(BED_TYPES).find((k) => (plate || '').toLowerCase().includes(k));
	return key ? BED_TYPES[key] : 'Textured PEI Plate';
}

/**
 * Bambu Studio's machine preset for a model and nozzle: "<model name> <nozzle> nozzle" for every model
 * in the catalogue (resources/profiles/BBL/machine at the pin).
 */
export function machinePreset(model: ModelCode, nozzle: string): string {
	const printer = PRINTER_MODELS[model];
	if (!printer) throw new AppError(422, `Unknown printer model ${model}.`);
	return `${printer.name} ${nozzle || '0.4'} nozzle`;
}

/** Picks the Bambu Studio profiles closest to a job's settings. */
export function chooseProfiles(b: ProfileBook, s: SliceSettings): SliceChoice {
	const printer = PRINTER_MODELS[s.model];
	const machine = machinePreset(s.model, s.nozzle);
	b.flat('printer', machine); // throws a clear error for a nozzle Bambu Studio does not know
	const processes = b.compatible('process', machine);
	const layer = Number(s.layerHeight) || 0.2;
	const byLayer = processes
		.map((p) => ({ p, h: Number(String(p.name).match(/^([\d.]+)mm/)?.[1] ?? NaN) }))
		.filter((x) => Number.isFinite(x.h))
		.sort((a, c) => Math.abs(a.h - layer) - Math.abs(c.h - layer));
	const nearest = byLayer.filter((x) => x.h === byLayer[0]?.h);
	const process =
		nearest.find((x) => /Standard/.test(x.p.name))?.p ??
		nearest.find((x) => /Balanced/.test(x.p.name))?.p ??
		nearest[0]?.p;
	if (!process) throw new AppError(500, `Bambu Studio has no print profile for ${machine}.`);

	const filaments = b.compatible('filament', machine);
	const wanted = (s.material || 'PLA').toUpperCase();
	const type = wanted.match(/PLA|PETG|ABS|ASA|TPU|PCTG|PC|PA|PET|PVA|HIPS/)?.[0] ?? 'PLA';
	const words = wanted
		.replace(type, '')
		.split(/[^A-Z0-9]+/)
		.filter(Boolean);
	const ofType = filaments.filter((f) => {
		if (!/^Bambu /.test(f.name)) return false;
		const t = b.flat('filament', f.name).filament_type; // usually inherited
		return Array.isArray(t) && String(t[0]).toUpperCase() === type;
	});
	const score = (f: Profile) =>
		words.filter((w) => f.name.toUpperCase().includes(w)).length * 10 +
		(/Basic/.test(f.name) ? 3 : 0) +
		(/ HF\b/.test(f.name) ? 2 : 0) -
		(/(CF|GF|Aero|Support|Silk|Glow|Marble|Sparkle|Metal|Galaxy|Wood|Translucent)/.test(f.name)
			? 5
			: 0);
	const filament = ofType.sort((a, c) => score(c) - score(a))[0];
	if (!filament)
		throw new AppError(
			422,
			`Bambu Studio has no ${type} filament profile for the ${printer.short}.`
		);
	return {
		machine,
		process: process.name,
		filament: filament.name,
		bedType: bedTypeFor(s.plate)
	};
}

/** A choice as the protocol's preset selection (system presets). */
export function selectionOf(choice: Pick<SliceChoice, 'machine' | 'process' | 'filament'>) {
	return {
		printer: { kind: 'printer', name: choice.machine, source: 'system' },
		process: { kind: 'process', name: choice.process, source: 'system' },
		filaments: [{ kind: 'filament', name: choice.filament, source: 'system' }]
	} satisfies PresetSelection;
}
