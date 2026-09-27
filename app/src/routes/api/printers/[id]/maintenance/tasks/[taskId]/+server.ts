import { api, readJson } from '$lib/server/http';
import { maintenanceOf } from '$lib/server/modules/maintenance/service';

/** Edits a task (label, intervals, notes). */
export const PATCH = api(async ({ params, request }, rt) => {
	const m = maintenanceOf(rt);
	const task = m.store.updateTask(params.id!, params.taskId!, await readJson(request, 10_000));
	m.changed(params.id!);
	return { task, overview: m.overview(params.id!) };
});

/** Removes a task (its log entries stay). */
export const DELETE = api(({ params }, rt) => {
	const m = maintenanceOf(rt);
	m.store.deleteTask(params.id!, params.taskId!);
	m.changed(params.id!);
	return { overview: m.overview(params.id!) };
});
