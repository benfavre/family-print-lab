import { api, readJson } from '$lib/server/http';

export const PATCH = api(async ({ request, params }, rt) =>
	rt.lab.updateJob(params.id!, await readJson(request))
);
export const DELETE = api(({ params }, rt) => rt.lab.deleteJob(params.id!));
