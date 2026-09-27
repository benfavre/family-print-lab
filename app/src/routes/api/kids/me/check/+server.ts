import { api } from '$lib/server/http';
import { needKid } from '$lib/server/kid/things';
import { needKids } from '$lib/server/modules/kids/api';

/** Kid mode: whether asking for this thing (in this colour) fits the child's limits right now. */
export const GET = api(({ locals, url }, rt) =>
	needKids(rt).selfCheck(
		needKid(locals.kid).id,
		url.searchParams.get('project') ?? '',
		url.searchParams.get('spool') || null
	)
);
