import { api, readJson } from '$lib/server/http';
import { queueOf } from '$lib/server/modules/queue/api';

/** The queue: items, each printer's switches and why things wait. */
export const GET = api((_e, rt) => queueOf(rt).list());

/** Adds a queued job (to a printer's column, or "any printer" with printerId null). */
export const POST = api(async ({ request }, rt) => {
	const queue = queueOf(rt);
	const item = queue.add(await readJson(request));
	return { item, queue: queue.list() };
});
