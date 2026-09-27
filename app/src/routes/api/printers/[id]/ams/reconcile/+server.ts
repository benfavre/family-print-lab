import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { amsService } from '$lib/server/modules/ams/service';
import { reconcileInput } from '$lib/server/modules/ams/validation';

/** Takes the printer's estimate of what is left on the RFID spool in a tray ({ tray }). */
export const POST = api(async ({ request, params }, rt) => {
	const { tray } = parse(reconcileInput, await readJson(request));
	amsService(rt).reconcile(params.id!, tray);
	return { ok: true };
});
