import { api } from '$lib/server/http';
import { integrations } from '$lib/server/integrations';

/** Status of every integration (cached for a minute; ?refresh=1 checks again now). */
export const GET = api(({ url }, rt) => integrations(rt, url.searchParams.has('refresh')));
