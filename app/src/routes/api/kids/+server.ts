import { api } from '$lib/server/http';
import { needKids } from '$lib/server/modules/kids/api';

/** The parent's overview: each child's limits and usage, badges, recent requests; photos wanted. */
export const GET = api((_event, rt) => needKids(rt).overview());
