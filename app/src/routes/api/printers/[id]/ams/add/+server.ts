import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { amsService } from '$lib/server/modules/ams/service';
import { trayInput } from '$lib/server/modules/ams/validation';

/** "Add to Filament": a new shelf spool from what the tray reports, linked to it ({ tray }). */
export const POST = api(async ({ request, params }, rt) => {
	const { tray } = parse(trayInput, await readJson(request));
	const ams = amsService(rt);
	const spoolId = ams.addFromTray(params.id!, tray);
	return { spoolId, ...ams.state(params.id!) };
});
