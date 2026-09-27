import { api, readJson } from '$lib/server/http';
import { cameraOf } from '$lib/server/modules/camera/http';

/** The camera settings (CameraSettings). */
export const GET = api((_, rt) => cameraOf(rt).settings.get());

export const PUT = api(async ({ request }, rt) => {
	const settings = cameraOf(rt).settings.set(await readJson(request));
	rt.lab.touch('settings');
	return { settings };
});
