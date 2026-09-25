// Slicing inside the app with Bambu Studio's command line: the model version's STL plus the job's
// settings (layer height, material, supports, infill, build plate) become a printable .gcode.3mf for
// the X2D. Bambu Studio's system profiles inherit from each other and the command line only accepts
// complete ones, so they are flattened here first. The CLI cannot render the plate picture without a
// GPU and leaves the printer model code blank; both are added afterwards, as the printer checks them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZip, rewriteZip } from './cad/mesh';
import { AppError } from './validation';

type Profile = Record<string, unknown> & { name: string; inherits?: string };
type Kind = 'machine' | 'process' | 'filament';

export interface SlicerInfo {
	available: boolean;
	path: string | null;
	version: string | null;
}

/** Finds Bambu Studio: BAMBU_STUDIO_PATH, then the newest unpacked install in ~/.local/opt. */
export function findSlicer(env: Record<string, string | undefined> = process.env): SlicerInfo {
	const candidates: string[] = [];
	if (env.BAMBU_STUDIO_PATH) candidates.push(env.BAMBU_STUDIO_PATH);
	const opt = path.join(os.homedir(), '.local/opt');
	if (fs.existsSync(opt))
		candidates.push(
			...fs
				.readdirSync(opt)
				.filter((d) => /^bambu-studio-\d/.test(d))
				.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
				.map((d) => path.join(opt, d, 'AppRun'))
		);
	const found = candidates.find((c) => fs.existsSync(c));
	return {
		available: !!found,
		path: found ?? null,
		version: found?.match(/bambu-studio-([\d.]+)/)?.[1] ?? null
	};
}

/** Profiles of one Bambu Studio install, indexed by kind and name (loaded once). */
class ProfileBook {
	private byName = new Map<string, Profile>();
	readonly modelIds = new Map<string, string>();

	constructor(readonly root: string) {
		for (const kind of ['machine', 'process', 'filament'] as Kind[]) {
			const dir = path.join(root, kind);
			if (!fs.existsSync(dir)) continue;
			for (const file of walk(dir)) {
				try {
					const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Profile;
					if (typeof p.name !== 'string') continue;
					this.byName.set(`${kind}:${p.name}`, p);
					if (kind === 'machine' && typeof p.model_id === 'string')
						this.modelIds.set(p.name, p.model_id);
				} catch {
					/* skip unreadable files */
				}
			}
		}
	}

	/** A profile with everything it inherits merged in, as the command line needs it. */
	flat(kind: Kind, name: string): Profile {
		const own = this.byName.get(`${kind}:${name}`);
		if (!own) throw new AppError(500, `Bambu Studio has no ${kind} profile “${name}”.`);
		const base = own.inherits ? this.flat(kind, own.inherits) : {};
		const out = { ...base, ...own } as Profile;
		delete out.inherits;
		return out;
	}

	/** Names of leaf (selectable) profiles of a kind that list this machine as compatible. */
	compatible(kind: Kind, machine: string): Profile[] {
		const out: Profile[] = [];
		for (const [key, p] of this.byName) {
			if (!key.startsWith(`${kind}:`) || p.instantiation === 'false') continue;
			const list = p.compatible_printers;
			if (Array.isArray(list) && list.includes(machine)) out.push(p);
		}
		return out;
	}
}

function* walk(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.name.endsWith('.json')) yield full;
	}
}

const books = new Map<string, ProfileBook>();
function book(bin: string) {
	const root = path.join(path.dirname(bin), 'resources/profiles/BBL');
	let b = books.get(root);
	if (!b) books.set(root, (b = new ProfileBook(root)));
	return b;
}

export interface SliceSettings {
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

const BED_TYPES: Record<string, string> = {
	'textured pei': 'Textured PEI Plate',
	'smooth pei': 'High Temp Plate',
	'high temp': 'High Temp Plate',
	engineering: 'Engineering Plate',
	'cool plate': 'Supertack Plate',
	supertack: 'Supertack Plate'
};

/** Picks the Bambu Studio profiles closest to a job's settings. */
export function chooseProfiles(bin: string, s: SliceSettings): SliceChoice {
	const b = book(bin);
	const machine = `Bambu Lab X2D ${s.nozzle || '0.4'} nozzle`;
	b.flat('machine', machine); // throws a clear error for a nozzle Bambu Studio does not know
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
		throw new AppError(422, `Bambu Studio has no ${type} filament profile for the X2D.`);

	const plateKey = Object.keys(BED_TYPES).find((k) => (s.plate || '').toLowerCase().includes(k));
	return {
		machine,
		process: process.name,
		filament: filament.name,
		bedType: plateKey ? BED_TYPES[plateKey] : 'Textured PEI Plate'
	};
}

export interface SliceResult {
	data: Buffer;
	choice: SliceChoice;
	minutes: number;
	grams: number;
	log: string;
}

/**
 * Slices an STL for the X2D. `thumbnail` (a PNG of the part) becomes the plate picture shown on the
 * printer. Runs Bambu Studio headless in a scratch folder; typical parts take a second or two.
 */
export async function slice(opts: {
	stl: Buffer;
	name: string;
	settings: SliceSettings;
	thumbnail?: Buffer | null;
	signal?: AbortSignal;
	onStage?: (text: string) => void;
	env?: Record<string, string | undefined>;
}): Promise<SliceResult> {
	const found = findSlicer(opts.env);
	if (!found.path) throw new AppError(503, 'Bambu Studio is not installed. See Integrations.');
	const bin = found.path;
	const choice = chooseProfiles(bin, opts.settings);
	const b = book(bin);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-slice-'));
	try {
		const write = (file: string, p: Profile) => {
			fs.writeFileSync(path.join(dir, file), JSON.stringify({ ...p, from: 'system' }));
		};
		const process = b.flat('process', choice.process);
		const s = opts.settings;
		if (s.infill !== null && s.infill >= 0 && s.infill <= 100)
			process.sparse_infill_density = `${Math.round(s.infill)}%`;
		process.enable_support = s.supports === 'None' ? '0' : '1';
		if (s.supports !== 'None')
			process.support_type = s.supports === 'Tree' ? 'tree(auto)' : 'normal(auto)';
		write('machine.json', b.flat('machine', choice.machine));
		write('process.json', process);
		const filament = b.flat('filament', choice.filament);
		// The spool's colour, so the printer (and the AMS matching) sees the right one.
		if (s.color && /^#?[0-9a-f]{6}$/i.test(s.color))
			filament.filament_colour = [`#${s.color.replace('#', '').toUpperCase()}`];
		write('filament.json', filament);
		// Never starts with "-", so the slicer cannot mistake the file for an option.
		const input = `part ${opts.name
			.replace(/[^\w .()+-]/g, '')
			.trim()
			.slice(0, 60)}.stl`;
		fs.writeFileSync(path.join(dir, input), opts.stl);
		fs.mkdirSync(path.join(dir, 'out'));

		opts.onStage?.('Slicing in Bambu Studio…');
		const log = await run(
			bin,
			[
				'--orient',
				'1',
				'--arrange',
				'1',
				'--load-settings',
				'machine.json;process.json',
				'--load-filaments',
				'filament.json',
				'--curr-bed-type',
				choice.bedType,
				'--slice',
				'0',
				'--outputdir',
				'out',
				'--export-3mf',
				'sliced.gcode.3mf',
				input
			],
			dir,
			opts.signal
		);
		const resultFile = path.join(dir, 'out/result.json');
		const result = fs.existsSync(resultFile)
			? (JSON.parse(fs.readFileSync(resultFile, 'utf8')) as {
					return_code?: number;
					error_string?: string;
					sliced_plates?: {
						total_predication?: number;
						filaments?: { total_used_g?: number }[];
					}[];
				})
			: null;
		const out = path.join(dir, 'out/sliced.gcode.3mf');
		if (!result || result.return_code !== 0 || !fs.existsSync(out))
			throw new AppError(
				422,
				`Bambu Studio could not slice this part: ${result?.error_string || lastLine(log) || 'no result'}.`
			);
		const plate = result.sliced_plates?.[0];
		opts.onStage?.('Preparing the file for the X2D…');
		const data = finish(
			fs.readFileSync(out),
			b.modelIds.get('Bambu Lab X2D') ?? 'N6',
			opts.thumbnail ?? null
		);
		return {
			data,
			choice,
			minutes: Math.max(1, Math.round((plate?.total_predication ?? 0) / 60)),
			grams:
				Math.round((plate?.filaments ?? []).reduce((a, f) => a + (f.total_used_g ?? 0), 0) * 10) /
				10,
			log
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Fills in the printer model code and plate pictures the command line leaves out. */
function finish(file: Buffer, modelId: string, thumbnail: Buffer | null): Buffer {
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
						/<metadata key="printer_model_id" value="[^"]*"\/>/,
						`<metadata key="printer_model_id" value="${modelId}"/>`
					)
			)
		);
	if (thumbnail)
		for (const name of entries.keys()) {
			const m = name.match(/^Metadata\/plate_(\d+)\.gcode\.md5$/);
			if (!m) continue;
			for (const pic of [`plate_${m[1]}.png`, `plate_no_light_${m[1]}.png`])
				if (!entries.has(`Metadata/${pic}`)) changes.set(`Metadata/${pic}`, thumbnail);
		}
	// Everything else, above all the large G-code, is copied as it is.
	return rewriteZip(file, changes);
}

function lastLine(log: string) {
	return (
		log
			.split('\n')
			.reverse()
			.find((l) => /error/i.test(l))
			?.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)*/, '')
			.slice(0, 200) ?? ''
	);
}

function run(bin: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let log = '';
		const keep = (b: Buffer) => {
			log = (log + b.toString()).slice(-20_000);
		};
		child.stdout.on('data', keep);
		child.stderr.on('data', keep);
		const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000);
		const abort = () => child.kill('SIGKILL');
		signal?.addEventListener('abort', abort, { once: true });
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on('close', () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			if (signal?.aborted) reject(new Error('Stopped'));
			else resolve(log);
		});
	});
}
