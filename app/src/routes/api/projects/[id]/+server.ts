import { api, readJson } from '$lib/server/http';

export const PATCH = api(async ({ request, params }, rt) =>
	rt.lab.updateProject(params.id!, await readJson(request))
);
export const DELETE = api(({ params }, rt) => {
	const result = rt.lab.deleteProject(params.id!);
	rt.models.sweep();
	rt.printing.sweep();
	return result;
});
