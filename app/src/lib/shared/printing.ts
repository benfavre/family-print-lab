// Matching a sliced file's filaments to what is loaded in the printer's AMS, used by the send dialog
// and checked again on the server.
import type { PrinterSnapshot, SlicedFilament } from './domain';

export interface LoadedSlot {
	/** Global slot number: AMS unit × 4 + tray (0-3 for the first AMS). */
	index: number;
	label: string;
	type: string;
	name: string;
	color: string | null;
	remain: number | null;
}

/** Every loaded AMS slot, labelled like the printer does (A1-A4, B1-B4…). */
export function loadedSlots(state: PrinterSnapshot | null | undefined): LoadedSlot[] {
	const out: LoadedSlot[] = [];
	for (const unit of state?.ams ?? []) {
		const u = Number(unit.unit) || 0;
		for (const tray of unit.trays) {
			if (!tray.type) continue;
			const t = Number(tray.slot) || 0;
			out.push({
				index: u * 4 + t,
				label: `${String.fromCharCode(65 + u)}${t + 1}`,
				type: tray.type,
				name: tray.name,
				color: tray.color,
				remain: tray.remain
			});
		}
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
			.map((s) => ({ s, score: colorDistance(f.color, s.color) + (used.has(s.index) ? 1000 : 0) }))
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
