import { api, readJson } from '$lib/server/http';
import { getSettings, saveSettings } from '$lib/server/settings';

export const GET = api((_, rt) => getSettings(rt.db));

export const PUT = api(async ({ request }, rt) => {
	const settings = saveSettings(rt.db, await readJson(request));
	rt.lab.touch('settings');
	return { settings };
});
