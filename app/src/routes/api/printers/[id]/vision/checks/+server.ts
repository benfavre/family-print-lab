import { api } from '$lib/server/http';
import { visionOf } from '$lib/server/modules/ai-vision/http';

/** A printer's check history, newest first (?before=<at>&limit=). */
export const GET = api(({ params, url }, rt) => ({
	checks: visionOf(rt).list(params.id!, Object.fromEntries(url.searchParams))
}));
