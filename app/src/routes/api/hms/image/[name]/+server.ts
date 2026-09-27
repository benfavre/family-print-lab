import fs from 'node:fs';
import path from 'node:path';
import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { HMS_DIR } from '$lib/server/modules/hms/database';

/** One of Bambu's error pictures (resources/hms/images, from Bambu Studio's local_image). */
export const GET = api(({ params }) => {
	const name = params.name ?? '';
	if (!/^[0-9a-f]{32}\.webp$/.test(name)) throw new AppError(404, 'No such picture.');
	const file = path.join(HMS_DIR, 'images', name);
	if (!fs.existsSync(file)) throw new AppError(404, 'No such picture.');
	return new Response(fs.readFileSync(file), {
		headers: {
			'content-type': 'image/webp',
			'cache-control': 'public, max-age=604800, immutable'
		}
	});
});
