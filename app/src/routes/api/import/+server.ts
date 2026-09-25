import { api, readJson } from '$lib/server/http';
import { parseImport, replaceWorkspace } from '$lib/server/portability';

/** Replaces the workspace with a backup file (v2 export or the previous app's family.json). A safety backup is taken first. */
export const POST = api(async ({ request }, rt) => {
	const data = parseImport(await readJson(request, 30_000_000));
	await rt.backups.create('before-import');
	replaceWorkspace(rt.db, rt.lab, data);
	rt.models.sweep(); // model files of projects that no longer exist
	return { imported: { projects: data.projects.length, jobs: data.jobs.length } };
});
