import { api, readJson } from '$lib/server/http';
import { queueOf } from '$lib/server/modules/queue/api';

/** Hold or release, move to another column, change its start time or plate check. */
export const PATCH = api(async ({ request, params }, rt) => {
	const queue = queueOf(rt);
	const item = queue.update(params.id!, await readJson(request));
	return { item, queue: queue.list() };
});

/** Takes a job out of the queue (the job itself stays). */
export const DELETE = api((event, rt) => {
	const queue = queueOf(rt);
	queue.remove(event.params.id!);
	return { queue: queue.list() };
});
