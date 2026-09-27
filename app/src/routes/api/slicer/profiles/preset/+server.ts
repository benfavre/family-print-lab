import { api } from '$lib/server/http';
import { profilesOf, refFromQuery } from '$lib/server/modules/slicer-profiles/http';

/** One preset resolved (?kind, ?name, ?source, ?id), its keys grouped like Bambu Studio's tabs. */
export const GET = api(({ url }, rt) => profilesOf(rt).detail(refFromQuery(url.searchParams)));
