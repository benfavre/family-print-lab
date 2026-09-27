import { api, readJson } from '$lib/server/http';
import { visionOf } from '$lib/server/modules/ai-vision/http';

/** The AI check settings, the methods to pick from, and whether ffmpeg and the camera are there. */
export const GET = api((_, rt) => visionOf(rt).view());

export const PUT = api(async ({ request }, rt) => {
	const view = visionOf(rt).saveSettings(await readJson(request));
	rt.lab.touch('settings');
	return view;
});
