import { api } from '$lib/server/http';
import { visionOf } from '$lib/server/modules/ai-vision/http';

/** The camera picture a check looked at (kept 14 days). */
export const GET = api(({ params }, rt) => {
	const jpeg = visionOf(rt).frame(params.id!, params.checkId!);
	return new Response(new Uint8Array(jpeg), {
		headers: {
			'content-type': 'image/jpeg',
			'content-length': String(jpeg.length),
			'cache-control': 'private, max-age=86400'
		}
	});
});
