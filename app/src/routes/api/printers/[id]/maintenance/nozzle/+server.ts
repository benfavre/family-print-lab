import { api, readJson } from '$lib/server/http';
import { maintenanceOf } from '$lib/server/modules/maintenance/service';

/** Logs a nozzle change ({ diameter, type, note, send }); with send, also tells the printer. */
export const POST = api(async ({ params, request }, rt) => {
	const m = maintenanceOf(rt);
	const entry = await m.changeNozzle(params.id!, await readJson(request, 10_000));
	return { entry, overview: m.overview(params.id!) };
});
