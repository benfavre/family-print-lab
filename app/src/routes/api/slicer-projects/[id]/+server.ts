import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';
import { projectSchema, renameProject } from '$lib/server/modules/slicer-3mf/validation';
import type { Project } from '$lib/shared/slicer/project';
import type { SlicerProjectDetail } from '$lib/shared/slicer-3mf';

/** The project file read into the Project model. */
export const GET = api(({ params }, rt): SlicerProjectDetail => {
	const store = projectStore(rt);
	const summary = store.summary(params.id!);
	return { ...summary, ...store.read(params.id!) };
});

/**
 * Saves the Project JSON as the project file. Send the revision you loaded as If-Match to refuse
 * overwriting a newer save (409).
 */
export const PUT = api(async ({ request, params }, rt) => {
	const project = parse(projectSchema, await readJson(request, 200_000_000)) as Project;
	const match = request.headers.get('if-match');
	const revision = match === null ? undefined : Number(match.replace(/"/g, ''));
	if (revision !== undefined && !Number.isInteger(revision))
		throw new AppError(400, 'If-Match must be a revision number.');
	// No workspace in the answer: nothing in it changed.
	return json({ slicerProject: projectStore(rt).saveSync(params.id!, project, revision) });
});

export const PATCH = api(async ({ request, params }, rt) => {
	const { name } = parse(renameProject, await readJson(request));
	return { slicerProject: projectStore(rt).rename(params.id!, name) };
});

export const DELETE = api(({ params }, rt) => {
	projectStore(rt).remove(params.id!);
	return {};
});
