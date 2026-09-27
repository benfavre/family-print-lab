import { api } from '$lib/server/http';
import { importsOf } from '$lib/server/modules/model-import/route';

/** A preview picture from a model site's image server (only those hosts; size-capped). */
export const GET = api(async ({ url, request }, rt) => {
	const image = await importsOf(rt).imports.image(
		url.searchParams.get('url') ?? '',
		request.signal
	);
	return new Response(new Uint8Array(image.body), {
		headers: {
			'content-type': image.type,
			'cache-control': 'private, max-age=3600',
			'x-content-type-options': 'nosniff'
		}
	});
});
