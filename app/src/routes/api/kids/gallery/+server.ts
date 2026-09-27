import { api, readJson } from '$lib/server/http';
import { needKids } from '$lib/server/modules/kids/api';

/** The family gallery, newest first (?profile=<id> for one maker). */
export const GET = api(({ url }, rt) => ({
	items: needKids(rt).gallery(url.searchParams.get('profile'))
}));

/** Adds a photo (JPEG or WebP data URL, at most 400 KB) for a print or a maker. */
export const POST = api(async ({ request }, rt) => ({
	item: needKids(rt).addPhoto(await readJson(request, 700_000))
}));
