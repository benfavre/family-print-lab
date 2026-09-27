import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { workspaceOf } from '$lib/server/modules/slicer-ui/module';
import { orientBody } from '$lib/server/modules/slicer-ui/validation';

/** Auto-orients objects of the saved project; answers their new transforms. */
export const POST = api(async ({ request, params }, rt) =>
	json(await workspaceOf(rt).orient(params.id!, parse(orientBody, await readJson(request))))
);
