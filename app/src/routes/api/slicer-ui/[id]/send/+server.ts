import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { workspaceOf } from '$lib/server/modules/slicer-ui/module';
import { sendBody } from '$lib/server/modules/slicer-ui/validation';

/**
 * A new print job for a sliced plate with the file attached, added to the print queue (queue: true)
 * or left for the send window.
 */
export const POST = api(async ({ request, params }, rt) =>
	workspaceOf(rt).send(params.id!, parse(sendBody, await readJson(request)))
);
