import { api, readJson } from '$lib/server/http';
import { needKid } from '$lib/server/kid/things';

/** The child asks a grown-up to print this. */
export const POST = api(async ({ request, locals, params }, rt) => ({
	id: rt.lab.requestPrint(needKid(locals.kid).id, params.id!, await readJson(request))
}));
