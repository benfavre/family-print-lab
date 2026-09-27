import { api, readJson } from '$lib/server/http';
import { queueOf } from '$lib/server/modules/queue/api';

/** A printer's queue switches: `{ autoDispatch?, paused?, plateCleared?: true, startNext?: true }`. */
export const POST = api(async ({ request, params }, rt) => {
	const queue = queueOf(rt);
	const result = queue.printer(params.id!, await readJson(request));
	return { ...result, queue: queue.list() };
});
