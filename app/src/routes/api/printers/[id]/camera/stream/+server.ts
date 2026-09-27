import { api } from '$lib/server/http';
import { cameraOf } from '$lib/server/modules/camera/http';
import { MJPEG_CONTENT_TYPE, mjpegPart } from '$lib/server/modules/camera/mjpeg';

/**
 * The live camera as multipart/x-mixed-replace JPEG frames, for an <img>. One stream per printer is
 * shared by all viewers; a viewer that cannot keep up skips frames rather than falling behind.
 */
export const GET = api(({ params, request }, rt) => {
	const camera = cameraOf(rt);
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let first: Buffer | null = null;
	let ended = false;
	let off = () => {};
	const close = () => {
		ended = true;
		off();
		try {
			controller?.close();
		} catch {
			/* already closed */
		}
	};
	// Subscribing first means "no camera" is a plain 409 with the reason, not a broken stream.
	off = camera.subscribe(
		params.id!,
		(jpeg) => {
			if (!controller) return void (first = jpeg);
			if ((controller.desiredSize ?? 1) <= 0) return;
			controller.enqueue(mjpegPart(jpeg));
		},
		close
	);
	request.signal.addEventListener('abort', close, { once: true });
	const stream = new ReadableStream<Uint8Array>(
		{
			start(c) {
				controller = c;
				if (ended) return void c.close();
				if (first) c.enqueue(mjpegPart(first));
				first = null;
			},
			cancel() {
				ended = true;
				off();
			}
		},
		new CountQueuingStrategy({ highWaterMark: 3 })
	);
	return new Response(stream, {
		headers: {
			'content-type': MJPEG_CONTENT_TYPE,
			'cache-control': 'no-store',
			'x-accel-buffering': 'no'
		}
	});
});
