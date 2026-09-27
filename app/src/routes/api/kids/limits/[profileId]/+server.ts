import { api, readJson } from '$lib/server/http';
import { needKids } from '$lib/server/modules/kids/api';

/** A child's limits and what is used of them. */
export const GET = api(({ params }, rt) => {
	const kids = needKids(rt);
	return { limits: kids.limits(params.profileId!), usage: kids.usage(params.profileId!) };
});

/** Replaces a child's limits (null = no limit of that kind). */
export const PUT = api(async ({ request, params }, rt) => ({
	limits: needKids(rt).setLimits(params.profileId!, await readJson(request))
}));
