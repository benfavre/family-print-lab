import { api, readJson } from '$lib/server/http';
import { needKids } from '$lib/server/modules/kids/api';

/** Changes a photo's caption. */
export const PATCH = api(async ({ request, params }, rt) => {
	needKids(rt).updatePhoto(params.id!, await readJson(request));
	return { ok: true };
});

export const DELETE = api(({ params }, rt) => {
	needKids(rt).deletePhoto(params.id!);
	return { ok: true };
});
