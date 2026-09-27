import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { amsService } from '$lib/server/modules/ams/service';
import { trayInput } from '$lib/server/modules/ams/validation';

/** Asks the AMS to read a tray's RFID tag again ({ tray }). */
export const POST = api(async ({ request, params }, rt) => {
	const { tray } = parse(trayInput, await readJson(request));
	amsService(rt).tray(params.id!, tray);
	const outcome = await rt.printers.require(params.id!).send('print.ams_get_rfid', { tray });
	return { outcome: outcome.outcome };
});
