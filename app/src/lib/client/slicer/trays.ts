// A printer's filament trays (AMS units and the external spool holder) as choices for the workspace's
// filament slots. The first guess of which tray each slot takes is shared/printing.ts autoMapping, the
// same one the send window and the queue use.
import { autoMapping, loadedSlots, type LoadedSlot } from '$lib/shared/printing';
import type { PrinterStatus } from '$lib/shared/printers/status';
import type { FilamentSlot } from '$lib/shared/slicer/project';

export type TrayChoice = LoadedSlot;

/** Loaded trays of a printer (AMS units, then external spools), labelled as the printer does. */
export const trayChoices = (printer: PrinterStatus | null | undefined): TrayChoice[] =>
	loadedSlots(printer?.state);

/** The tray each slot would take (autoMapping), null where nothing of its material is loaded. */
export const suggestTrays = (slots: FilamentSlot[], trays: TrayChoice[]): (number | null)[] =>
	autoMapping(slots, trays).map((index) => (index < 0 ? null : index));

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
