import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { workspaceOf } from '$lib/server/modules/slicer-ui/module';
import { sliceBody } from '$lib/server/modules/slicer-ui/validation';

/**
 * Slices a plate of the saved project as a background task (send the revision you saved as `revision`;
 * a newer save on the server is refused). Cancel it with POST /api/tasks/[id]/cancel.
 */
export const POST = api(async ({ request, params }, rt) => {
	const body = parse(sliceBody, await readJson(request, 3_000_000));
	return json({ task: workspaceOf(rt).slice(params.id!, body) });
});
