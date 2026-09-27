import { api, readJson } from '$lib/server/http';
import { queueOf } from '$lib/server/modules/queue/api';

/** Puts one column in order: `{ printerId, ids }`; items named from other columns move into it. */
export const POST = api(async ({ request }, rt) => {
	const queue = queueOf(rt);
	queue.reorder(await readJson(request));
	return { queue: queue.list() };
});
