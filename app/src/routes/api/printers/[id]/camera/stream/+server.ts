import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { cameraOf } from '$lib/server/modules/camera/http';
import { MJPEG_CONTENT_TYPE, mjpegPart } from '$lib/server/modules/camera/mjpeg';

/**
 * The live camera as multipart/x-mixed-replace JPEG frames, for an <img>. One stream per printer is
 * shared by all viewers; a viewer that cannot keep up skips frames rather than falling behind.
 */
export const GET = api(({ params, request }, rt) => {
	const camera = cameraOf(rt);
	const id = params.id!;
	const state = camera.state(id);
	if (!state.available) throw new AppError(409, state.message);
	let off = () => {};
	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				const close = () => {
					off();
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				};
				off = camera.subscribe(
					id,
					(jpeg) => {
						if ((controller.desiredSize ?? 1) <= 0) return;
						controller.enqueue(mjpegPart(jpeg));
					},
					close
				);
				request.signal.addEventListener('abort', close, { once: true });
			},
			cancel() {
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
