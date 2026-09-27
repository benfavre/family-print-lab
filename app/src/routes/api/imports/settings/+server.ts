import { api, readJson } from '$lib/server/http';
import { importsOf } from '$lib/server/modules/model-import/route';

/** Whether a Thingiverse token is saved (never the token itself). */
export const GET = api((_event, rt) => importsOf(rt).settings());

/** Saves or removes the Thingiverse app token. */
export const PUT = api(async ({ request }, rt) => ({
	settings: importsOf(rt).saveSettings(await readJson(request, 2_000))
}));
