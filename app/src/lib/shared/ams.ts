// AMS sync (ams package), shared by the server and the browser: which shelf spool is in which tray,
// how a tray is matched to a spool, how humidity and drying read, and the generic Bambu filament
// presets the tray settings dialog offers.
import { colorDistance, trayLabel } from './printing';
import type { Spool } from './domain';
import {
	EXT_DEPUTY,
	EXT_MAIN,
	type AmsUnit,
	type GlobalTray,
	type PrinterTray
} from './printers/status';

/** The columns the ams package adds to spools (present on workspace spools at runtime). */
export interface AmsSpoolFields {
	/** The Bambu RFID spool's tray_uuid. */
	rfidUuid: string | null;
	/** Its tag_uid (the chip's id; each spool has two tags). */
	rfidTag: string | null;
	/** Bambu filament id (tray_info_idx), e.g. "GFA00". */
	bambuInfoIdx: string | null;
	spoolmanId: number | null;
}
export type AmsSpool = Spool & Partial<AmsSpoolFields>;

export interface AmsLink {
	printerId: string;
	tray: GlobalTray;
	spoolId: string;
	linkedAt: string;
	lastRemain: number | null;
	lastUuid: string | null;
}

/** The AMS reading options (Bambu Studio DevFilaSystem.cpp ~535: insert_flag, power_on_flag, calibrate_remain_flag). */
export interface AmsOptions {
	/** Read RFID tags when the AMS starts. */
	startupRead: boolean | null;
	/** Read RFID tags when a spool is inserted. */
	trayRead: boolean | null;
	/** Estimate what is left on spools. */
	remainCalibrate: boolean | null;
}

/** GET /api/printers/[id]/ams */
export interface AmsState {
	printerId: string;
	links: AmsLink[];
	options: AmsOptions | null;
}

/** GET /api/spoolman (the token itself never leaves the server). */
export interface SpoolmanView {
	enabled: boolean;
	url: string;
	hasToken: boolean;
	pushUsage: boolean;
	/** The last push or sync that failed, in words (cleared by the next success). */
	lastError: string | null;
	/** Shelf spools that came from Spoolman. */
	imported: number;
}

export type TrayMatch =
	| { kind: 'linked'; spoolId: string }
	/** The shelf has this RFID spool (the server links it by itself). */
	| { kind: 'rfid'; spoolId: string }
	/** A Bambu RFID spool that is not on the shelf yet: one click adds it. */
	| { kind: 'new-rfid' }
	/** Spools of the same material and a close colour, best first; the person confirms. */
	| { kind: 'suggest'; spoolIds: string[]; ambiguous: boolean }
	| { kind: 'none' };

/** "PLA Matte" and "PLA-S" are both PLA. */
export const materialFamily = (m: string) => m.toUpperCase().replace(/[-\s].*$/, '');
const isBambuBrand = (brand: string) => /bambu/i.test(brand);
/** Colours closer than this count as the same spool colour (0 … ~441). */
export const NEAR_COLOUR = 60;

/** Whether the tray holds this spool by its RFID: tray_uuid first, then tag_uid. */
export function sameRfid(tray: PrinterTray, spool: AmsSpool): boolean {
	if (tray.trayUuid && spool.rfidUuid) return tray.trayUuid === spool.rfidUuid;
	return !!tray.tagUid && !!spool.rfidTag && tray.tagUid === spool.rfidTag;
}

/**
 * Which shelf spool a tray holds: the linked one; else the spool with its RFID uuid (then tag); else
 * spools of the same material family with a close colour that no other tray holds (a tray with an
 * RFID tag only matches spools without one, and prefers Bambu Lab spools). `taken` = spools linked
 * to other trays.
 */
export function matchTray(
	tray: PrinterTray,
	spools: AmsSpool[],
	o: { linkedSpoolId?: string | null; taken?: Set<string> } = {}
): TrayMatch {
	if (!tray.type) return { kind: 'none' };
	if (o.linkedSpoolId && spools.some((s) => s.id === o.linkedSpoolId))
		return { kind: 'linked', spoolId: o.linkedSpoolId };
	const rfid = tray.trayUuid || tray.tagUid;
	if (rfid) {
		const byTag = spools.find((s) => sameRfid(tray, s));
		if (byTag) return { kind: 'rfid', spoolId: byTag.id };
	}
	const candidates = spools
		.filter((s) => !o.taken?.has(s.id))
		.filter((s) => !(rfid && s.rfidUuid))
		.filter((s) => materialFamily(s.material) === materialFamily(tray.type))
		.map((s) => ({
			s,
			d:
				colorDistance(tray.color, s.colorHex) +
				(rfid && !isBambuBrand(s.brand) ? 30 : 0) +
				(s.remainingGrams <= 0 ? 40 : 0)
		}))
		.filter((c) => colorDistance(tray.color, c.s.colorHex) < NEAR_COLOUR)
		.sort((a, b) => a.d - b.d);
	if (!candidates.length) return rfid ? { kind: 'new-rfid' } : { kind: 'none' };
	return {
		kind: 'suggest',
		spoolIds: candidates.map((c) => c.s.id),
		ambiguous: candidates.length > 1 && candidates[1].d - candidates[0].d < 25
	};
}

/**
 * Whether a tray still holds the spool it was linked to: false once it is empty, holds another RFID
 * spool (or a plain one where an RFID spool was), or another material or colour.
 */
export function stillHolds(tray: PrinterTray | undefined, spool: AmsSpool): boolean {
	if (!tray?.type) return false;
	const rfid = tray.trayUuid || tray.tagUid;
	if (spool.rfidUuid || spool.rfidTag) return !!rfid && sameRfid(tray, spool);
	if (rfid) return false;
	return (
		materialFamily(tray.type) === materialFamily(spool.material) &&
		colorDistance(tray.color, spool.colorHex) < NEAR_COLOUR * 1.5
	);
}

/**
 * The printer's estimate for an RFID spool when it disagrees with the shelf by more than 10 % of the
 * spool (shown to the person, never applied silently); null when they agree or there is nothing to
 * compare.
 */
export function remainDisagreement(
	tray: PrinterTray | undefined,
	spool: AmsSpool
): { printerGrams: number } | null {
	if (!tray || tray.remain === null || tray.remain < 0 || !(spool.rfidUuid || spool.rfidTag))
		return null;
	const printerGrams = Math.round((tray.remain / 100) * spool.totalGrams);
	return Math.abs(printerGrams - spool.remainingGrams) > spool.totalGrams * 0.1
		? { printerGrams }
		: null;
}

// ---------- Humidity and drying ----------

/**
 * Humidity on a 1 (dry) … 5 (wet) scale, the way ha-bambulab shows it (definitions.py humidity_index
 * "6 - value"): the printer's own `humidity` index counts the other way (5 = dry). As Bambu Studio does
 * (Widgets/AMSItem.cpp get_humidity_display_idx), the AMS 2 Pro and AMS HT are placed from
 * `humidity_raw` % (under 20 % driest … 80 % and over wettest) and other units from the index; either
 * one stands in when the other is missing.
 */
export function humidityLevel(
	u: Pick<AmsUnit, 'humidityIndex' | 'humidityPercent'> & Partial<Pick<AmsUnit, 'model'>>
): number | null {
	const fromPercent = (p: number) => (p < 20 ? 1 : p < 40 ? 2 : p < 60 ? 3 : p < 80 ? 4 : 5);
	const byPercent = u.model === 'AMS 2 Pro' || u.model === 'AMS HT';
	if (u.humidityPercent !== null && (byPercent || u.humidityIndex === null))
		return fromPercent(u.humidityPercent);
	return u.humidityIndex === null ? null : 6 - u.humidityIndex;
}
export const HUMIDITY_WORD: Record<number, string> = {
	1: 'Dry',
	2: 'Dry',
	3: 'OK',
	4: 'Humid',
	5: 'Wet'
};

/** AMS `info` bits 4–7 while remote drying is supported (Bambu Studio DevFilaSystem.h DryStatus). */
export const DRY_STATUS: Record<number, string> = {
	0: 'Off',
	1: 'Checking',
	2: 'Drying',
	3: 'Cooling',
	4: 'Stopping',
	5: 'Drying error',
	6: 'Heater fault',
	7: 'Factory test'
};

/** Drying temperature range per unit (Bambu Studio AMSDryControl.cpp ~1186: AMS 2 Pro 45–65 °C, AMS HT 45–85 °C); null when it cannot dry. */
export function dryingRange(model: AmsUnit['model']): { min: number; max: number } | null {
	if (model === 'AMS 2 Pro') return { min: 45, max: 65 };
	if (model === 'AMS HT') return { min: 45, max: 85 };
	return null;
}
/** Hours a drying cycle may run (AMSDryControl.cpp ~1236). */
export const DRYING_HOURS = { min: 1, max: 24 };

/**
 * What to dry a unit's filament at: the gentlest filament loaded decides, as in Bambu Studio
 * (AMSDryControl.cpp ~1700–1743 takes the lowest drying temperature over the unit's trays), using each
 * tray's own drying_temp / drying_time (Bambu spools carry them on the RFID tag) within the unit's
 * range; else 55 °C for 8 hours.
 */
export function dryingDefaults(unit: Pick<AmsUnit, 'model' | 'trays'>): {
	temp: number;
	hours: number;
	filament: string;
} {
	const range = dryingRange(unit.model) ?? { min: 45, max: 65 };
	const loaded = unit.trays.filter((t) => t.type);
	const tray =
		loaded
			.filter((t) => t.dryingTemp !== null && t.dryingTemp > 0)
			.sort((a, b) => a.dryingTemp! - b.dryingTemp!)[0] ?? loaded[0];
	const temp = Math.min(range.max, Math.max(range.min, tray?.dryingTemp || 55));
	const hours = Math.min(DRYING_HOURS.max, Math.max(DRYING_HOURS.min, tray?.dryingHours || 8));
	return { temp, hours, filament: tray?.type ?? '' };
}

// ---------- Tray settings ----------

export interface FilamentPreset {
	/** The shelf material (MATERIALS). */
	material: string;
	/** tray_type sent to the printer. */
	type: string;
	/** Bambu filament id (tray_info_idx) of the generic profile. */
	infoIdx: string;
	tempMin: number;
	tempMax: number;
}

/**
 * Bambu's generic filament profiles (Bambu Studio v02.08.02.61 resources/profiles/BBL/filament:
 * "Generic <type> @base" filament_id, nozzle ranges from those files or the fdm_filament_<type> they
 * inherit).
 */
export const FILAMENT_PRESETS: FilamentPreset[] = [
	{ material: 'PLA', type: 'PLA', infoIdx: 'GFL99', tempMin: 190, tempMax: 240 },
	{ material: 'PLA Matte', type: 'PLA', infoIdx: 'GFL99', tempMin: 190, tempMax: 240 },
	{ material: 'PLA Silk', type: 'PLA', infoIdx: 'GFL96', tempMin: 190, tempMax: 240 },
	{ material: 'PLA-CF', type: 'PLA-CF', infoIdx: 'GFL98', tempMin: 190, tempMax: 240 },
	{ material: 'PETG', type: 'PETG', infoIdx: 'GFG99', tempMin: 220, tempMax: 270 },
	{ material: 'PETG-CF', type: 'PETG-CF', infoIdx: 'GFG98', tempMin: 240, tempMax: 270 },
	{ material: 'ABS', type: 'ABS', infoIdx: 'GFB99', tempMin: 240, tempMax: 280 },
	{ material: 'ASA', type: 'ASA', infoIdx: 'GFB98', tempMin: 240, tempMax: 280 },
	{ material: 'TPU', type: 'TPU', infoIdx: 'GFU99', tempMin: 200, tempMax: 250 },
	{ material: 'PA', type: 'PA', infoIdx: 'GFN99', tempMin: 240, tempMax: 280 },
	{ material: 'PC', type: 'PC', infoIdx: 'GFC99', tempMin: 260, tempMax: 290 }
];

/** The generic preset for a shelf material or tray type (by family when there is no exact one). */
export function presetFor(material: string): FilamentPreset | null {
	const m = material.trim().toUpperCase();
	return (
		FILAMENT_PRESETS.find((p) => p.material.toUpperCase() === m) ??
		FILAMENT_PRESETS.find((p) => p.type.toUpperCase() === m) ??
		FILAMENT_PRESETS.find((p) => p.type === materialFamily(m)) ??
		null
	);
}

/** '#rrggbb' → the printer's 'RRGGBBAA' (alpha FF; OpenBambuAPI mqtt.md print.ams_filament_setting). */
export function trayColour(hex: string): string {
	const m = hex.replace('#', '').match(/^[0-9a-f]{6}/i);
	return `${(m?.[0] ?? 'FFFFFF').toUpperCase()}FF`;
}

const NAMED: [string, string][] = [
	['White', '#ffffff'],
	['Black', '#111111'],
	['Grey', '#8a8a8a'],
	['Silver', '#c0c0c0'],
	['Red', '#d32f2f'],
	['Orange', '#f57c00'],
	['Yellow', '#fbc02d'],
	['Green', '#2e9d49'],
	['Mint', '#76d9b4'],
	['Cyan', '#00bcd4'],
	['Blue', '#1e5bd6'],
	['Purple', '#7e3fb8'],
	['Pink', '#f48fb1'],
	['Brown', '#795548'],
	['Beige', '#e0cda9']
];
/** A plain colour name for a hex colour (the closest of a short list). */
export function colourName(hex: string | null): string {
	if (!hex) return '';
	return NAMED.reduce(
		(best, [name, c]) => {
			const d = colorDistance(hex, c);
			return d < best.d ? { name, d } : best;
		},
		{ name: '', d: Infinity }
	).name;
}

/** Where a tray is, in words: "X1C, tray A1" (the printer name only when there are several). */
export function trayPlace(
	tray: GlobalTray,
	o: { printerName?: string; dual?: boolean; several?: boolean } = {}
): string {
	const where =
		tray === EXT_MAIN || tray === EXT_DEPUTY
			? trayLabel(tray, o.dual).replace('Ext', 'external spool')
			: `tray ${trayLabel(tray, o.dual)}`;
	return o.several && o.printerName ? `${o.printerName}, ${where}` : where;
}

/** A shelf spool made from what a tray reports ("Add to Filament"). */
export function spoolFromTray(tray: PrinterTray): {
	input: {
		brand: string;
		material: string;
		colorName: string;
		colorHex: string;
		totalGrams: number;
		remainingGrams: number;
		notes: string;
	};
	rfid: Pick<AmsSpoolFields, 'rfidUuid' | 'rfidTag' | 'bambuInfoIdx'>;
} {
	const rfid = !!(tray.trayUuid || tray.tagUid);
	const total = tray.weight && tray.weight >= 50 ? tray.weight : 1000;
	const hex = (tray.color ?? '#ffffff').slice(0, 7);
	const remaining =
		tray.remain !== null && tray.remain >= 0 ? Math.round((tray.remain / 100) * total) : total;
	return {
		input: {
			brand: rfid || tray.isBambu ? 'Bambu Lab' : '',
			material: tray.type.slice(0, 40),
			colorName: colourName(hex),
			colorHex: hex,
			totalGrams: total,
			remainingGrams: Math.min(total, remaining),
			notes: tray.name ? tray.name.slice(0, 200) : ''
		},
		rfid: {
			rfidUuid: tray.trayUuid,
			rfidTag: tray.tagUid,
			bambuInfoIdx: tray.infoIdx || null
		}
	};
}

/** Every tray of a snapshot, AMS units first, then external spools. */
export function allTrays(state: { ams: AmsUnit[]; externalSpools: PrinterTray[] }): PrinterTray[] {
	return [...state.ams.flatMap((u) => u.trays), ...state.externalSpools];
}
