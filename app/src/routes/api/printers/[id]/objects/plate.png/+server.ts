import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { controlsService } from '$lib/server/modules/controls/service';

/** The slicer's picture of the plate being printed, for the skip objects map. */
export const GET = api(({ params }, rt) => {
	const png = controlsService(rt).platePicture(params.id!);
	if (!png) throw new AppError(404, 'No plate picture for this print.');
	return new Response(new Uint8Array(png), {
		headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' }
	});
});
