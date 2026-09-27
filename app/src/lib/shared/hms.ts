// Printer errors in plain words: how HMS alerts and print errors are decoded, the offline database
// format (app/resources/hms/hms-en.json.gz, built by app/tools/hms/build-hms.ts) and what the API
// returns. Pure, so the server, the builder and the tests share it.
import type { HmsCode } from './printers/status';

export type HmsSeverity = 'fatal' | 'serious' | 'common' | 'info' | 'unknown';
export type HmsKind = 'hms' | 'print_error';

export interface HmsSettings {
	language: 'en' | 'fr';
}

/** Where the wiki's HMS pages start; used when there is no page for a code. */
export const WIKI_HOME = 'https://wiki.bambulab.com/en/hms/home';
export const WIKI_BASE = 'https://wiki.bambulab.com';

/**
 * HMS severity from `code >> 16`: 1 fatal, 2 serious, 3 common, 4 info (ha-bambulab
 * pybambu/utils.py get_HMS_severity and const.py HMS_SEVERITY_LEVELS; Bambu Studio DevHMS.cpp
 * parse_hms_info reads the same field as the message level).
 */
export function hmsSeverity(code: number | null): HmsSeverity {
	if (!code || code < 0) return 'unknown';
	return (['unknown', 'fatal', 'serious', 'common', 'info'] as const)[code >>> 16] ?? 'unknown';
}

/**
 * Print error level from bits 12–15: 0x4 error, 0x8 warning, 0xC info (Bambu Studio
 * DeviceErrorDialog.cpp parse_error_level ~226). Mapped onto the HMS scale: error → serious,
 * warning → common, info → info.
 */
export function printErrorSeverity(error: number): HmsSeverity {
	const level = (error & 0xf000) >>> 12;
	return level === 0x4 ? 'serious' : level === 0x8 ? 'common' : level === 0xc ? 'info' : 'unknown';
}

/** Module ids (ha-bambulab const.py HMS_MODULES, read from `attr >> 24` by get_HMS_module). */
const MODULES: Record<number, string> = {
	0x03: 'mc',
	0x05: 'mainboard',
	0x07: 'ams',
	0x08: 'toolhead',
	0x0c: 'xcam'
};
/** The same names in plain words, for the UI. */
export const MODULE_LABELS: Record<string, string> = {
	mc: 'Motion',
	mainboard: 'Mainboard',
	ams: 'AMS',
	toolhead: 'Toolhead',
	xcam: 'Camera and AI',
	unknown: 'Printer'
};

/** The module an HMS `attr` names (ha-bambulab utils.py get_HMS_module). */
export function hmsModule(attr: number | null): string {
	if (!attr || attr < 0) return 'unknown';
	return MODULES[(attr >>> 24) & 0xff] ?? 'unknown';
}

/**
 * The module a print error belongs to, from its top byte. Bambu's print errors share the HMS module
 * numbering (every 0700xxxx text in Bambu Studio resources/hms/hms_en_*.json device_error is about
 * the AMS, 0300xxxx about motion, 0C00xxxx about the cameras and AI).
 */
export function printErrorModule(error: number): string {
	return MODULES[(error >>> 24) & 0xff] ?? 'unknown';
}

const hex = (n: number, width: number) => (n >>> 0).toString(16).toUpperCase().padStart(width, '0');

/**
 * The 16-hex key the HMS data uses: `attr` and `code` as 8-hex each. Bambu Studio DevHMS.cpp
 * get_long_error_code prints %02X%02X%02X%02X00%02X%04X over module/num/part/reserved/level/msg,
 * which is the same thing.
 */
export function hmsKeyOf(h: HmsCode): string {
	return hex(h.attr ?? 0, 8) + hex(h.code ?? 0, 8);
}

/** The 8-hex key of a print error (Bambu Studio HMS.cpp query_print_error_msg: "%08X"). */
export function printErrorKey(error: number): string {
	return hex(error, 8);
}

/** A key as people read it: `0700_2000_0002_0001` (HMS) or `0700_8011` (print error). */
export function displayCode(key: string): string {
	return key.match(/.{4}/g)?.join('_') ?? key;
}

/** Normalises what people type or paste ("0700_2000_0002_0001", "0700-8011", "07008011"). */
export function parseCodeInput(input: string): { kind: HmsKind; key: string } | null {
	const clean = input.replace(/[\s_-]/g, '').toUpperCase();
	if (/^[0-9A-F]{16}$/.test(clean)) return { kind: 'hms', key: clean };
	if (/^[0-9A-F]{8}$/.test(clean)) return { kind: 'print_error', key: clean };
	return null;
}

/** The raw attr/code (HMS) or the number (print error) behind a key. */
export function codeFromKey(key: string): HmsCode | number {
	if (key.length === 16)
		return { attr: parseInt(key.slice(0, 8), 16), code: parseInt(key.slice(8), 16) };
	return parseInt(key, 16);
}

// ---------- Offline database format ----------

/** One value for every printer, or per HMS device prefix with an optional `default`. */
export type PerDevice<T> = T | { [device: string]: T };

export interface HmsDatabaseFile {
	/** Format version of this file. */
	format: 1;
	/** Newest `ver` of the Bambu Studio files it was built from (their timestamps, e.g. 202511162200). */
	version: string;
	language: string;
	sources: HmsSource[];
	/** Device prefix → model short names ("094" → ["H2D"]). */
	devices: Record<string, string[]>;
	/** Every distinct text once; index 0 is "" (a code Bambu keeps internal: no alert is shown). */
	messages: string[];
	/** 16-hex HMS key → message index. */
	hms: Record<string, PerDevice<number>>;
	/** 8-hex print error key → message index. */
	errors: Record<string, PerDevice<number>>;
	/** 16-hex key → wiki path under https://wiki.bambulab.com. */
	wiki: Record<string, PerDevice<string>>;
	/** 8- or 16-hex key → action ids per device prefix (or "default"), as Bambu Studio lists them. */
	actions: Record<string, Record<string, number[]>>;
	/** 8- or 16-hex key → picture (file name under resources/hms/images) per device prefix or "default". */
	images: Record<string, Record<string, string>>;
}

export interface HmsSource {
	name: string;
	url: string;
	/** Tag and/or commit the data was read at. */
	ref: string;
	licence: string;
	/** What was taken from it. */
	used: string;
}

// ---------- What the API returns ----------

export interface HmsActionView {
	id: number;
	label: string;
	/** The printer command it sends; null = shown for information only (never, today). */
	command: string | null;
	/** 'confirm': ask first (stopping a print). */
	risk: 'safe' | 'confirm' | 'parent';
}

/** One code in plain words (the HmsInfo contract plus what the UI shows). */
export interface HmsAlert {
	key: string;
	/** `0700_2000_0002_0001` or `0700_8011`. */
	code: string;
	kind: HmsKind;
	severity: HmsSeverity;
	module: string;
	text: string;
	/** False when the database has no text for this code. */
	known: boolean;
	wikiUrl: string | null;
	actions: HmsActionView[];
	/** URL of Bambu's picture for this code, when one ships. */
	image: string | null;
}

export interface HmsEventRow {
	id: string;
	printerId: string;
	kind: HmsKind;
	code: string;
	severity: HmsSeverity;
	text: string;
	raisedAt: string;
	clearedAt: string | null;
	jobId: string | null;
}

export interface HmsPrinterView {
	active: HmsAlert[];
	history: HmsEventRow[];
	/** Total history rows matching the filter. */
	total: number;
}

/** Severity order for sorting (worst first). */
export const SEVERITY_ORDER: Record<HmsSeverity, number> = {
	fatal: 0,
	serious: 1,
	common: 2,
	info: 3,
	unknown: 4
};

export const SEVERITY_LABELS: Record<HmsSeverity, string> = {
	fatal: 'Fatal',
	serious: 'Serious',
	common: 'Warning',
	info: 'Info',
	unknown: 'Unknown'
};
