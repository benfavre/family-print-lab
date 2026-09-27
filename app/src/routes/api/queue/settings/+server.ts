import { api, readJson } from '$lib/server/http';
import { queueOf } from '$lib/server/modules/queue/api';

/** Quiet hours and the "require plate cleared" default. */
export const GET = api((_e, rt) => queueOf(rt).settings());

export const PUT = api(async ({ request }, rt) => {
	const queue = queueOf(rt);
	return { settings: queue.settings(await readJson(request)), queue: queue.list() };
});
