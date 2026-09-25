import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { rename } from '$lib/server/cad/requests';

/** Editor detail: the model, all versions (with sources), the current version and its parameters. */
export const GET = api(({ params }, rt) => rt.models.detail(params.id!));

export const PATCH = api(async ({ request, params }, rt) => {
	rt.models.rename(params.id!, parse(rename, await readJson(request)).name);
	return { ok: true };
});

export const DELETE = api(({ params }, rt) => {
	rt.models.remove(params.id!);
	return { ok: true };
});
