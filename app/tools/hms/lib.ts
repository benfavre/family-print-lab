// The pure half of the HMS database builder (build-hms.ts does the reading and writing): merges
// Bambu Studio's per-device HMS files with ha-bambulab's all-model tables into one compact file.
import type { HmsDatabaseFile, HmsSource, PerDevice } from '../../src/lib/shared/hms';

/** Bambu Studio resources/hms/hms_<lang>_<device>.json (checked at the pinned tag). */
export interface BambuHmsFile {
	ver?: number | string;
	data?: {
		device_hms?: { ver?: number | string; [lang: string]: unknown };
		device_error?: { ver?: number | string; [lang: string]: unknown };
	};
}
/** Bambu Studio resources/hms/hms_action_<device>.json. */
export interface BambuActionFile {
	ver?: number | string;
	data?: { ecode?: string; actions?: number[]; image?: string; device?: string }[];
}
/** ha-bambulab pybambu/hms_error_text/hms_<lang>.json.gz: code → { text: [models] } ([] = every model). */
export interface HaHmsFile {
	device_hms?: Record<string, Record<string, string[]>>;
	device_error?: Record<string, Record<string, string[]>>;
}
/** ha-bambulab wiki_links.json.gz: code → { path: [models] }. */
export type HaWikiFile = Record<string, Record<string, string[]>>;

export interface BuildInput {
	language: string;
	/** One entry per device prefix Bambu Studio ships, in a stable order. */
	bambu: { device: string; info: BambuHmsFile; actions: BambuActionFile | null }[];
	ha: HaHmsFile | null;
	wiki: HaWikiFile | null;
	/** ha-bambulab model name → device prefix ("X1C" → "00M"). */
	haDevices: Record<string, string>;
	/** Device prefix → model short names, for the file's `devices` table. */
	devices: Record<string, string[]>;
	sources: HmsSource[];
	/** Picture names that made it into the output (the builder drops ones it could not convert). */
	images?: (name: string) => string | null;
}

export interface BuildReport {
	file: HmsDatabaseFile;
	/** ha-bambulab model names with no device prefix (their device-specific texts are skipped). */
	unknownModels: string[];
	/** Every picture Bambu's action files name, before conversion. */
	imageNames: string[];
}

const HEX16 = /^[0-9A-F]{16}$/;
const HEX8 = /^[0-9A-F]{8}$/;

/** Picks a `default` (the most common value, first seen wins a tie) and drops devices that match it. */
export function collapse<T extends string | number>(
	byDevice: Map<string, T>,
	explicitDefault?: T
): PerDevice<T> | null {
	if (!byDevice.size && explicitDefault === undefined) return null;
	let fallback = explicitDefault;
	if (fallback === undefined) {
		const counts = new Map<T, number>();
		for (const v of byDevice.values()) counts.set(v, (counts.get(v) ?? 0) + 1);
		let best = -1;
		for (const [v, n] of counts)
			if (n > best) {
				best = n;
				fallback = v;
			}
	}
	const out: Record<string, T> = {};
	for (const [device, v] of [...byDevice].sort(([a], [b]) => a.localeCompare(b)))
		if (v !== fallback) out[device] = v;
	if (!Object.keys(out).length) return fallback as T;
	return { ...out, default: fallback as T };
}

function entries(block: unknown, language: string): { ecode: string; intro: string }[] {
	const list = (block as Record<string, unknown> | undefined)?.[language];
	if (!Array.isArray(list)) return [];
	return list
		.filter((e) => e && typeof e.ecode === 'string' && typeof e.intro === 'string')
		.map((e) => ({ ecode: String(e.ecode).toUpperCase(), intro: String(e.intro).trim() }));
}

const sortKeys = <T>(o: Record<string, T>) =>
	Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export function buildDatabase(input: BuildInput): BuildReport {
	const messages: string[] = [''];
	const index = new Map<string, number>([['', 0]]);
	const msg = (text: string) => {
		let i = index.get(text);
		if (i === undefined) {
			i = messages.length;
			messages.push(text);
			index.set(text, i);
		}
		return i;
	};
	const unknownModels = new Set<string>();
	const devicesOf = (models: string[]) =>
		models.flatMap((m) => {
			const d = input.haDevices[m];
			if (!d) unknownModels.add(m);
			return d ? [d] : [];
		});

	const table = (kind: 'device_hms' | 'device_error', pattern: RegExp) => {
		const perCode = new Map<string, { devices: Map<string, number>; fallback?: number }>();
		const slot = (key: string) => {
			let s = perCode.get(key);
			if (!s) perCode.set(key, (s = { devices: new Map() }));
			return s;
		};
		// ha-bambulab first (every model, from Bambu's public query), then Bambu Studio's files at the
		// pin override it for the devices they cover.
		for (const [code, texts] of Object.entries(input.ha?.[kind] ?? {})) {
			const key = code.replace(/_/g, '').toUpperCase();
			if (!pattern.test(key)) continue;
			for (const [text, models] of Object.entries(texts)) {
				const s = slot(key);
				const i = msg(text.trim());
				if (!models.length) s.fallback ??= i;
				else for (const d of devicesOf(models)) if (!s.devices.has(d)) s.devices.set(d, i);
			}
		}
		for (const { device, info } of input.bambu)
			for (const { ecode, intro } of entries(info.data?.[kind], input.language)) {
				if (!pattern.test(ecode)) continue;
				const s = slot(ecode);
				// An empty print error text is Bambu's "internal" marker (HMS.cpp _is_internal_error:
				// no dialog); an empty HMS text just has nothing to add, so keep what ha-bambulab says.
				if (!intro && kind === 'device_hms' && (s.devices.has(device) || s.fallback !== undefined))
					continue;
				s.devices.set(device, msg(intro));
			}
		const out: Record<string, PerDevice<number>> = {};
		for (const [key, s] of perCode) {
			const v = collapse(s.devices, s.fallback);
			if (v !== null) out[key] = v;
		}
		return sortKeys(out);
	};

	const hms = table('device_hms', HEX16);
	const errors = table('device_error', HEX8);

	const wiki: Record<string, PerDevice<string>> = {};
	for (const [code, paths] of Object.entries(input.wiki ?? {})) {
		const key = code.replace(/_/g, '').toUpperCase();
		if (!HEX16.test(key)) continue;
		const devices = new Map<string, string>();
		let fallback: string | undefined;
		for (const [p, models] of Object.entries(paths)) {
			if (!/^\/[\w/.-]+$/.test(p)) continue;
			if (!models.length) fallback ??= p;
			else for (const d of devicesOf(models)) if (!devices.has(d)) devices.set(d, p);
		}
		const v = collapse(devices, fallback);
		if (v !== null) wiki[key] = v;
	}

	// Actions and pictures the way Bambu Studio picks them (HMS.cpp _query_error_image_action): the
	// first entry for the code whose device is this printer's prefix or "default".
	const actions: Record<string, Record<string, number[]>> = {};
	const images: Record<string, Record<string, string>> = {};
	const imageNames = new Set<string>();
	for (const { device, actions: file } of input.bambu) {
		const seen = new Set<string>();
		for (const e of file?.data ?? []) {
			const key = String(e.ecode ?? '').toUpperCase();
			if (!HEX8.test(key) && !HEX16.test(key)) continue;
			const owner = String(e.device ?? '').toUpperCase() === 'DEFAULT' ? 'default' : e.device;
			if (owner !== device && owner !== 'default') continue;
			const ids = (Array.isArray(e.actions) ? e.actions : []).filter(
				(n) => Number.isInteger(n) && n > 0
			);
			const image = typeof e.image === 'string' && /^[\w-]+\.png$/.test(e.image) ? e.image : '';
			if (image) imageNames.add(image);
			const shipped = image ? (input.images?.(image) ?? null) : null;
			const put = (who: string) => {
				if (ids.length) (actions[key] ??= {})[who] ??= ids;
				if (shipped) (images[key] ??= {})[who] ??= shipped;
			};
			if (owner === 'default') put('default');
			if (seen.has(key)) continue;
			seen.add(key);
			put(device);
		}
	}
	// A device that says the same as "default" needs no entry of its own.
	for (const table of [actions, images] as Record<string, Record<string, unknown>>[])
		for (const byDevice of Object.values(table)) {
			const fallback = JSON.stringify(byDevice.default);
			if (byDevice.default === undefined) continue;
			for (const d of Object.keys(byDevice))
				if (d !== 'default' && JSON.stringify(byDevice[d]) === fallback) delete byDevice[d];
		}

	const versions = input.bambu
		.flatMap(({ info }) => [info.ver, info.data?.device_hms?.ver, info.data?.device_error?.ver])
		.map((v) => String(v ?? ''))
		.filter((v) => /^\d+$/.test(v))
		.sort();
	return {
		file: {
			format: 1,
			version: versions.at(-1) ?? '0',
			language: input.language,
			sources: input.sources,
			devices: sortKeys(input.devices),
			messages,
			hms,
			errors,
			wiki: sortKeys(wiki),
			actions: sortKeys(actions),
			images: sortKeys(images)
		},
		unknownModels: [...unknownModels].sort(),
		imageNames: [...imageNames].sort()
	};
}
