import { api } from '$lib/server/http';
import { needKids } from '$lib/server/modules/kids/api';
import { AppError } from '$lib/server/validation';

/** A gallery photo. In kid mode, only the child's own. */
export const GET = api(({ params, locals }, rt) => {
	const row = needKids(rt).image(params.id!);
	if (!row || (locals.kid && row.profileId !== locals.kid.id))
		throw new AppError(404, 'That photo no longer exists.');
	return new Response(new Uint8Array(row.image), {
		headers: {
			'content-type': row.mime,
			// Photos never change once added (a new one gets a new id).
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
});
