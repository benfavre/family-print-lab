import { api, readJson } from '$lib/server/http';

export const PATCH = api(async ({ request, params }, rt) =>
	rt.lab.updateStep(params.id!, params.stepId!, await readJson(request))
);
export const DELETE = api(({ params }, rt) => rt.lab.removeStep(params.id!, params.stepId!));
