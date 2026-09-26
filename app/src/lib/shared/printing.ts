// Matching a sliced file's filaments to what is loaded in the printer's AMS, used by the send dialog
// and checked again on the server.
import type { PrinterSnapshot, SlicedFilament } from './domain';
import { EXT_DEPUTY, EXT_MAIN, type GlobalTray } from './printers/status';

export interface LoadedSlot {
	/** Global tray number (GlobalTray): AMS unit × 4 + tray, 128+ AMS HT, 24–27 A2L, 254/255 external. */
	index: GlobalTray;
	label: string;
	type: string;
	name: string;
	color: string | null;
	remain: number | null;
}

/** A tray's label as the printer shows it: A1–D4 for AMS units, HT1… for AMS HT, Ext for external spools. */
export function trayLabel(global: GlobalTray, dual = false): string {
	if (global === EXT_MAIN) return dual ? 'Ext R' : 'Ext';
	if (global === EXT_DEPUTY) return dual ? 'Ext L' : 'Ext 2';
	if (global >= 128 && global <= 135) return `HT${global - 127}`;
	if (global >= 24 && global <= 27) return `A${global - 23}`;
	return `${String.fromCharCode(65 + (global >> 2))}${(global & 3) + 1}`;
}

/** Every loaded tray (AMS units and external spools), labelled like the printer does. */
export function loadedSlots(state: PrinterSnapshot | null | undefined): LoadedSlot[] {
	const out: LoadedSlot[] = [];
	const dual = (state?.nozzles?.length ?? 1) > 1;
	const trays = [...(state?.ams ?? []).flatMap((u) => u.trays), ...(state?.externalSpools ?? [])];
	for (const tray of trays) {
		if (!tray.type) continue;
		out.push({
			index: tray.global,
			label: trayLabel(tray.global, dual),
			type: tray.type,
			name: tray.name,
			color: tray.color,
			remain: tray.remain
		});
	}
	return out;
}

const rgb = (hex: string | null) => {
	const m = hex?.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
	return m ? m.slice(1, 4).map((h) => parseInt(h, 16)) : null;
};
/** 0 (same) … ~441 (black vs white). */
export function colorDistance(a: string | null, b: string | null): number {
	const x = rgb(a),
		y = rgb(b);
	if (!x || !y) return 200;
	return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const family = (type: string) => type.toUpperCase().replace(/[-\s].*$/, '');

/**
 * Picks a slot for each filament: same material first, then the closest colour; a slot is used once
 * when possible. -1 where nothing of that material is loaded.
 */
export function autoMapping(filaments: SlicedFilament[], slots: LoadedSlot[]): number[] {
	const used = new Set<number>();
	return filaments.map((f) => {
		const same = slots.filter((s) => family(s.type) === family(f.type));
		const ranked = same
			.map((s) => ({
				s,
				// AMS trays first; an external spool when nothing else fits as well.
				score:
					colorDistance(f.color, s.color) +
					(used.has(s.index) ? 1000 : 0) +
					(s.index === EXT_MAIN || s.index === EXT_DEPUTY ? 100 : 0)
			}))
			.sort((a, b) => a.score - b.score);
		const pick = ranked[0]?.s;
		if (!pick) return -1;
		used.add(pick.index);
		return pick.index;
	});
}

/** Problems with a mapping, in plain words (empty when it is fine to print). */
export function mappingProblems(
	filaments: SlicedFilament[],
	mapping: number[],
	slots: LoadedSlot[]
): string[] {
	const problems: string[] = [];
	filaments.forEach((f, i) => {
		const slot = slots.find((s) => s.index === mapping[i]);
		if (!slot) problems.push(`Filament ${f.id} (${f.type}) has no AMS slot.`);
		else if (family(slot.type) !== family(f.type))
			problems.push(`Filament ${f.id} is ${f.type} but slot ${slot.label} holds ${slot.type}.`);
		else if (slot.remain !== null && slot.remain >= 0 && slot.remain < 5)
			problems.push(`Slot ${slot.label} is almost empty.`);
	});
	return problems;
}
