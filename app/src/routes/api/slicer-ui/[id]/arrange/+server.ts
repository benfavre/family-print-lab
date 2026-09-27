import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { workspaceOf } from '$lib/server/modules/slicer-ui/module';
import { arrangeBody } from '$lib/server/modules/slicer-ui/validation';

/** Auto-arranges a plate (or every unlocked one) of the saved project; answers the new placements. */
export const POST = api(async ({ request, params }, rt) =>
	json(await workspaceOf(rt).arrange(params.id!, parse(arrangeBody, await readJson(request))))
);
