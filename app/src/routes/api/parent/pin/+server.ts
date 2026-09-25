import { api, readJson } from '$lib/server/http';

/** Sets the parent PIN, or changes it (with the current PIN). */
export const POST = api(async ({ request }, rt) => {
	rt.pin.set(await readJson(request));
	rt.lab.touch('settings', 'Parent PIN updated');
	return { ok: true };
});
