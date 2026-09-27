import { api } from '$lib/server/http';
import { cameraOf, contentDisposition } from '$lib/server/modules/camera/http';

/** The newest camera picture (at most 2 s old). ?download=1 saves it as a file. */
export const GET = api(async ({ params, request, url }, rt) => {
	const jpeg = await cameraOf(rt).getSnapshot(params.id!, { signal: request.signal });
	const headers: Record<string, string> = {
		'content-type': 'image/jpeg',
		'content-length': String(jpeg.length),
		'cache-control': 'no-store'
	};
	if (url.searchParams.get('download') === '1') {
		const name = rt.printers.get(params.id!)?.name ?? 'printer';
		const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
		headers['content-disposition'] = contentDisposition('attachment', `${name} ${stamp}.jpg`);
	}
	return new Response(new Uint8Array(jpeg), { headers });
});
