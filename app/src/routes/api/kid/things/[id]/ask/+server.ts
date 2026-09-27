import { api, readJson } from '$lib/server/http';
import { needKid } from '$lib/server/kid/things';

/**
 * The child asks a grown-up to print this. The kids module (when running) first checks the child's
 * limits, refusing kindly when over one, and says yes on its own to small prints when the parent
 * allowed that.
 */
export const POST = api(async ({ request, locals, params }, rt) => {
	const kid = needKid(locals.kid);
	const body = await readJson(request);
	const kids = rt.module('kids');
	const check = kids?.checkAsk(kid.id, params.id!, body);
	const id = rt.lab.requestPrint(kid.id, params.id!, body);
	return { id, approved: check ? kids!.afterAsk(id, check) : false };
});
