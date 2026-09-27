import { api, readJson } from '$lib/server/http';
import { notifications } from '$lib/server/modules/notifications/api';

/** Channels, event toggles and templates; secrets are never sent back (hasToken and friends). */
export const GET = api((_e, rt) => notifications(rt).settings());

/** Saves them; a missing or empty secret keeps the saved one, null removes it. */
export const PUT = api(async ({ request }, rt) => ({
	settings: notifications(rt).saveSettings(await readJson(request))
}));
