import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';
import { createFromModels } from '$lib/server/modules/slicer-3mf/validation';

/** Slicer projects, all or one project's (?projectId=). */
export const GET = api(({ url }, rt) => ({
	slicerProjects: projectStore(rt).list(url.searchParams.get('projectId') ?? undefined)
}));

/** A new slicer project holding model versions (upload a file with POST /import instead). */
export const POST = api(async ({ request }, rt) => {
	const body = parse(createFromModels, await readJson(request));
	return {
		slicerProject: projectStore(rt).createFromModels(body.projectId, body.name, body.versions)
	};
});
