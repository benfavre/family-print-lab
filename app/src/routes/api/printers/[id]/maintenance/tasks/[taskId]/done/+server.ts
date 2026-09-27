import { api, readJson } from '$lib/server/http';
import { maintenanceOf } from '$lib/server/modules/maintenance/service';

/** Marks a task done now ({ note? }): resets its counters and logs it. */
export const POST = api(async ({ params, request }, rt) => {
	const m = maintenanceOf(rt);
	const body = request.headers.get('content-type') ? await readJson(request, 10_000) : {};
	const task = m.store.markDone(params.id!, params.taskId!, body);
	m.changed(params.id!);
	return { task, overview: m.overview(params.id!) };
});
