// A printer's filament trays (AMS units and the external spool holder) as choices for the workspace's
// filament slots, and a first guess of which tray each slot takes (same material, nearest colour),
// like the AMS mapping Bambu Studio suggests before sending.
import { loadedSlots, type LoadedSlot } from '$lib/shared/printing';
import type { PrinterStatus } from '$lib/shared/printers/status';
import type { FilamentSlot } from '$lib/shared/slicer/project';

export type TrayChoice = LoadedSlot;

/** Loaded trays of a printer (AMS units, then external spools), labelled as the printer does. */
export const trayChoices = (printer: PrinterStatus | null | undefined): TrayChoice[] =>
	loadedSlots(printer?.state);

const rgb = (c: string | null) => {
	const m = /^#?([0-9a-f]{6})/i.exec(c ?? '');
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return [n >> 16, (n >> 8) & 255, n & 255];
};

/** Distance between two colours (0 same, larger further apart); unknown colours count as far. */
export function colourDistance(a: string | null, b: string | null): number {
	const x = rgb(a),
		y = rgb(b);
	if (!x || !y) return 1000;
	return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * The tray each slot would take: same material type first, then the nearest colour; a tray is used
 * once while others are free. Slots with no loaded tray of their material get null.
 */
export function suggestTrays(slots: FilamentSlot[], trays: TrayChoice[]): (number | null)[] {
	const used = new Set<number>();
	return slots.map((s) => {
		const same = trays.filter((t) => t.type.toUpperCase() === s.type.toUpperCase());
		const pool = same.filter((t) => !used.has(t.index));
		const pick = [...(pool.length ? pool : same)].sort(
			(a, b) => colourDistance(a.color, s.color) - colourDistance(b.color, s.color)
		)[0];
		if (!pick) return null;
		used.add(pick.index);
		return pick.index;
	});
}

/** A slot taking a tray: its colour and material follow the tray, as loaded. */
export function slotFromTray(slot: FilamentSlot, tray: TrayChoice | null): FilamentSlot {
	if (!tray) return { ...slot, tray: null };
	return {
		...slot,
		tray: tray.index,
		color: tray.color ? `#${tray.color.replace('#', '').slice(0, 6).toUpperCase()}` : slot.color,
		type: tray.type || slot.type
	};
}
