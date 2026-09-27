import { api, readJson } from '$lib/server/http';
import { maintenanceOf } from '$lib/server/modules/maintenance/service';

/** Adds a task of the user's own. */
export const POST = api(async ({ params, request }, rt) => {
	const m = maintenanceOf(rt);
	const task = m.store.addTask(params.id!, await readJson(request, 10_000));
	m.changed(params.id!);
	return { task, overview: m.overview(params.id!) };
});
