import { api, readJson } from '$lib/server/http';
import { needKids } from '$lib/server/modules/kids/api';

/** Camera photos for the gallery on or off, and the time zone the limits use. */
export const PATCH = api(async ({ request }, rt) => ({
	settings: needKids(rt).setSettings(await readJson(request))
}));
