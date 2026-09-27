import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { amsService } from '$lib/server/modules/ams/service';
import { linkInput, trayNumber } from '$lib/server/modules/ams/validation';

/** Links a shelf spool to a tray ({ tray, spoolId }). */
export const POST = api(async ({ request, params }, rt) => {
	const { tray, spoolId } = parse(linkInput, await readJson(request));
	const ams = amsService(rt);
	ams.link(params.id!, tray, spoolId);
	return ams.state(params.id!);
});

/** Unlinks a tray (?tray=N). */
export const DELETE = api(({ url, params }, rt) => {
	const tray = parse(trayNumber, Number(url.searchParams.get('tray')));
	const ams = amsService(rt);
	ams.unlink(params.id!, tray);
	return ams.state(params.id!);
});
