import { api, readJson } from '$lib/server/http';
import { maintenanceOf } from '$lib/server/modules/maintenance/service';

/** Sets the print hours the printer had before the app knew it ({ baselineHours }). */
export const PUT = api(async ({ params, request }, rt) => {
	const m = maintenanceOf(rt);
	const odometer = m.store.setBaseline(params.id!, await readJson(request, 10_000));
	m.changed(params.id!);
	return { odometer, overview: m.overview(params.id!) };
});
