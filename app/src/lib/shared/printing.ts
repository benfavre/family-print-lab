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
	/** Physical extruder: 0 right/main, 1 left/deputy; absent/null for legacy or unknown bindings. */
	nozzle?: 0 | 1 | null;
}

/** A tray's label as the printer shows it: A1–D4 for AMS units, HT1… for AMS HT, Ext for external spools. */
export function trayLabel(global: GlobalTray, dual = false): string {
	if (global === EXT_MAIN) return dual ? 'Ext R' : 'Ext';
	if (global === EXT_DEPUTY) return dual ? 'Ext L' : 'Ext 2';
	if (global >= 128 && global <= 135) return `HT${global - 127}`;
	if (global >= 24 && global <= 27) return `A${global - 23}`;
	return `${String.fromCharCode(65 + (global >> 2))}${(global & 3) + 1}`;
}

/** Loaded trays, or also empty trays when checking fixed feeder bindings before a send. */
export function loadedSlots(
	state: PrinterSnapshot | null | undefined,
	options: { includeEmpty?: boolean } = {}
): LoadedSlot[] {
	const out: LoadedSlot[] = [];
	const dual = (state?.nozzles?.length ?? 1) > 1;
	const trays = [
		...(state?.ams ?? []).flatMap((u) =>
			u.trays.map((tray) => ({
				tray,
				nozzle: u.nozzle === 0 ? (0 as const) : u.nozzle === 1 ? (1 as const) : null
			}))
		),
		...(state?.externalSpools ?? []).map((tray) => ({
			tray,
			nozzle: tray.global === EXT_DEPUTY ? (1 as const) : (0 as const)
		}))
	];
	for (const { tray, nozzle } of trays) {
		if (!tray.type && !options.includeEmpty) continue;
		out.push({
			index: tray.global,
			label: trayLabel(tray.global, dual),
			type: tray.type,
			name: tray.name,
			color: tray.color,
			remain: tray.remain,
			// filament_maps = 1 also names the sole nozzle in single-extruder files.
			nozzle: dual ? nozzle : null
		});
	}
	if (dual && options.includeEmpty) {
		// DevDefs.h reserves these external spool ids for a physical side even if no spool is reported.
		for (const [index, nozzle] of [
			[EXT_MAIN, 0],
			[EXT_DEPUTY, 1]
		] as const) {
			if (!out.some((s) => s.index === index))
				out.push({
					index,
					nozzle,
					label: trayLabel(index, true),
					type: '',
					name: '',
					color: null,
					remain: null
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
export function autoMapping(
	filaments: Pick<SlicedFilament, 'type' | 'color' | 'extruder'>[],
	slots: LoadedSlot[]
): number[] {
	const used = new Set<number>();
	return filaments.map((f) => {
		const same = slots.filter((s) => slotFitsNozzle(f, s) && family(s.type) === family(f.type));
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

/**
 * Bambu Studio v02.08.02.61 SelectMachine.cpp do_ams_mapping splits filament_maps 1/2 into
 * left/right; DeviceCore/DevMapping.cpp ams_filament_mapping filters AMS bindings and external
 * spools by side. DevDefs.h: physical main/right = 0, deputy/left = 1 (opposite numbering).
 * Older files/reports and filament switchers may lack a binding: do not invent one for them.
 */
export function slotFitsNozzle(
	filament: Pick<SlicedFilament, 'extruder'>,
	slot: LoadedSlot
): boolean {
	return (
		filament.extruder === undefined ||
		slot.nozzle == null ||
		slot.nozzle === (filament.extruder === 1 ? 1 : 0)
	);
}

/** A known wrong-side feeder cannot be overridden like a material warning. */
export function mappingNozzleProblems(
	filaments: SlicedFilament[],
	mapping: number[],
	slots: LoadedSlot[]
): string[] {
	return filaments.flatMap((f, i) => {
		const slot = slots.find((s) => s.index === mapping[i]);
		return slot && !slotFitsNozzle(f, slot)
			? [
					`Filament ${f.id} uses the ${f.extruder === 1 ? 'left' : 'right'} nozzle, but slot ${slot.label} feeds the other nozzle.`
				]
			: [];
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
