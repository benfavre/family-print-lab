// The offline printer-error database (resources/hms/hms-<lang>.json.gz, built by tools/hms/build-hms.ts)
// and lookups in it: text, wiki page, Bambu's action ids and picture for a code on a given device.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
	WIKI_BASE,
	WIKI_HOME,
	type HmsDatabaseFile,
	type HmsKind,
	type PerDevice
} from '$lib/shared/hms';

export const HMS_DIR = path.resolve('resources/hms');

/** One value for a device: its own, else the `default`, else null. */
export function pick<T extends string | number>(
	entry: PerDevice<T> | undefined,
	device: string | null
): T | null {
	if (entry === undefined) return null;
	if (typeof entry !== 'object') return entry;
	return (device ? entry[device] : undefined) ?? entry.default ?? null;
}

export class HmsDatabase {
	constructor(readonly file: HmsDatabaseFile) {}

	get language() {
		return this.file.language;
	}

	/** The text for a code, '' for a code Bambu keeps internal, null when the code is unknown. */
	text(kind: HmsKind, key: string, device: string | null): string | null {
		const i = pick(kind === 'hms' ? this.file.hms[key] : this.file.errors[key], device);
		return i === null ? null : (this.file.messages[i] ?? null);
	}

	/**
	 * The wiki page for an HMS code: the one for this device, else the generic one, else the wiki's
	 * HMS home (ha-bambulab utils.py get_wiki_url_for_hms_error). Print errors have no pages of their own.
	 */
	wikiUrl(kind: HmsKind, key: string, device: string | null): string {
		if (kind !== 'hms') return WIKI_HOME;
		const p = pick(this.file.wiki[key], device);
		return p ? `${WIKI_BASE}${p}` : WIKI_HOME;
	}

	/** Bambu's action ids for a code on this device, else the "default" entry (HMS.cpp _query_error_image_action). */
	actions(key: string, device: string | null): number[] {
		const e = this.file.actions[key];
		return (e && ((device && e[device]) || e.default)) || [];
	}

	image(key: string, device: string | null): string | null {
		const e = this.file.images[key];
		return (e && ((device && e[device]) || e.default)) || null;
	}

	/** Whether the database has texts written for this device prefix. */
	knowsDevice(device: string): boolean {
		return device in this.file.devices;
	}
}

const cache = new Map<string, HmsDatabase | null>();

/**
 * The database for a language, falling back to English (the only one shipped today); null when no
 * file is there (a checkout that has not run `bun run hms:build`).
 */
export function loadHmsDatabase(language = 'en', dir = HMS_DIR): HmsDatabase | null {
	const id = `${dir}\0${language}`;
	if (cache.has(id)) return cache.get(id)!;
	let db: HmsDatabase | null = null;
	for (const lang of [...new Set([language.toLowerCase(), language.slice(0, 2), 'en'])]) {
		const file = path.join(dir, `hms-${lang.replace(/[^\w-]/g, '')}.json.gz`);
		if (!fs.existsSync(file)) continue;
		db = new HmsDatabase(JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')));
		break;
	}
	cache.set(id, db);
	return db;
}
