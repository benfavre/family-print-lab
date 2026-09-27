import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { controlsService } from '$lib/server/modules/controls/service';
import type { PlateImage } from '$lib/server/modules/controls/module';

const IMAGES: Record<string, PlateImage> = {
	'plate.png': 'plate',
	'top.png': 'top',
	'pick.png': 'pick'
};

/** The slicer's pictures of the plate being printed (plate, top view, pick image), for skip objects. */
export const GET = api(({ params }, rt) => {
	const which = IMAGES[params.image!];
	if (!which) throw new AppError(404, 'No such picture.');
	const png = controlsService(rt).platePicture(params.id!, which);
	if (!png) throw new AppError(404, 'No plate picture for this print.');
	return new Response(new Uint8Array(png), {
		headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' }
	});
});
