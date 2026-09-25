import { api, readJson } from '$lib/server/http';
import { makeThing, needKid } from '$lib/server/kid/things';

/** Saves what the child made as their own project with a parametric model. */
export const POST = api(async ({ request, locals }, rt) => {
	const body = (await readJson(request, 20_000)) as { template?: unknown; params?: unknown };
	return makeThing(rt, needKid(locals.kid), body.template, body.params);
});
