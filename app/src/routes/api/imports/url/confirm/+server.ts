import { api, readJson } from '$lib/server/http';
import { importsOf } from '$lib/server/modules/model-import/route';

/** Imports a previewed model page into a new or existing project (credits, files, pictures). */
export const POST = api(async ({ request }, rt) => ({
	result: await importsOf(rt).imports.confirm(await readJson(request, 20_000), request.signal)
}));
