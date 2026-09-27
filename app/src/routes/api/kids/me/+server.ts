import { api } from '$lib/server/http';
import { needKid } from '$lib/server/kid/things';
import { needKids } from '$lib/server/modules/kids/api';

/** Kid mode: the child's own badges and gallery, and whether they can ask for more today. */
export const GET = api(({ locals }, rt) => needKids(rt).self(needKid(locals.kid).id));
