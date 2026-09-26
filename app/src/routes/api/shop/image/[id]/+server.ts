import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';

/** Shop pictures, fetched from Print Lab Cloud by the server (the page only loads from here). */
export const GET: RequestHandler = async ({ params }) => {
	const rt = runtime();
	try {
		const image = await rt.cloud!.shopImage(params.id);
		return new Response(new Uint8Array(image), {
			headers: { 'content-type': 'image/webp', 'cache-control': 'private, max-age=86400' }
		});
	} catch {
		return new Response(null, { status: 404 });
	}
};
