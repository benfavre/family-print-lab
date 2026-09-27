import fs from 'node:fs';
import { api } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';
import { AppError } from '$lib/server/validation';

/** A printer model's picture from Bambu Studio's presets. */
export const GET = api(({ params }, rt) => {
	const cover = profilesOf(rt).cover(params.model!);
	if (!cover || !fs.existsSync(cover.path)) throw new AppError(404, 'No picture for that model.');
	return new Response(new Uint8Array(fs.readFileSync(cover.path)), {
		headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }
	});
});
