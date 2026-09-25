import { api, readJson } from '$lib/server/http';

/** A grown-up answers a child's print request: approve (queues a print job) or decline. */
export const POST = api(async ({ request, params }, rt) => ({
	jobId: rt.lab.decideRequest(params.id!, await readJson(request))
}));
