import { Readable } from 'node:stream';
import { api } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { cameraOf, contentDisposition, contentTypeFor } from '$lib/server/modules/camera/http';
import { mediaPathQuery } from '$lib/server/modules/camera/validation';

/**
 * One file from the printer, streamed straight through (never held in memory). The path must be one
 * its folder lists. ?inline=1 shows pictures and videos in the page instead of saving them.
 */
export const GET = api(async ({ params, url, request }, rt) => {
	const path = parse(mediaPathQuery, url.searchParams.get('path') ?? '');
	const { stream, size, name } = await cameraOf(rt).media.open(
		rt.printers.require(params.id!),
		path,
		request.signal
	);
	const type = contentTypeFor(name);
	const inline = url.searchParams.get('inline') === '1' && type !== 'application/octet-stream';
	return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
		headers: {
			'content-type': type,
			...(size !== null && { 'content-length': String(size) }),
			'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
			'cache-control': 'private, max-age=300'
		}
	});
});
