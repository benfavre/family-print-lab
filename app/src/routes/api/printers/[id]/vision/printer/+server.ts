import { api, readJson } from '$lib/server/http';
import { visionOf } from '$lib/server/modules/ai-vision/http';

/** Automatic checks on or off for this printer ({ enabled }). */
export const PUT = api(async ({ params, request }, rt) => {
	const overview = visionOf(rt).setPrinter(params.id!, await readJson(request));
	rt.lab.touch('settings');
	return { overview };
});
