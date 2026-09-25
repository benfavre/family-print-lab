import { api, readJson } from '$lib/server/http';

/** { to: 'Printing' | 'Succeeded' | 'Failed' | 'Cancelled' | 'Queued', printerTask? } */
export const POST = api(async ({ request, params }, rt) =>
	rt.lab.transitionJob(params.id!, await readJson(request))
);
