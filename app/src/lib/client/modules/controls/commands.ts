// Printer controls in the browser: run a typed printer command through the API, and describe a printer
// the way the server's command guards see it, so buttons are disabled for the reason the server would
// give.
import type { AppContext } from '$lib/client/app.svelte';
import { PRINTER_MODELS, capabilitiesFor } from '$lib/shared/printers/models';
import type { ControlTarget } from '$lib/shared/controls';
import type { PrinterStatus } from '$lib/shared/domain';

/** The printer as the command guards see it. */
export function controlTarget(printer: PrinterStatus): ControlTarget {
	const model = PRINTER_MODELS[printer.model ?? 'N6'] ?? PRINTER_MODELS.N6;
	return {
		model,
		caps: printer.caps ?? capabilitiesFor(model.code, null),
		status: printer.state ?? null
	};
}

/** Runs one printer command; true when the printer took it (errors are toasted). */
export async function runCommand(
	app: AppContext,
	printer: PrinterStatus,
	name: string,
	params: Record<string, unknown> = {},
	success?: string
): Promise<boolean> {
	if (!printer.id) return false;
	const res = await app.lab.call(
		'POST',
		`/api/printers/${printer.id}/commands`,
		{ name, params },
		success
	);
	return !!res;
}
