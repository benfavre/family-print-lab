import { api, readJson } from '$lib/server/http';

/** Applies one change to many projects in a single transaction. */
export const POST = api(async ({ request }, rt) => {
	const result = rt.lab.bulkProjects(await readJson(request));
	rt.models.sweep(); // model files of deleted projects
	rt.printing.sweep(); // and their sliced print files
	return result;
});
