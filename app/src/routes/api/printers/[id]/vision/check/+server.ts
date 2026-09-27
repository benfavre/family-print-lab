import { api } from '$lib/server/http';
import { visionOf } from '$lib/server/modules/ai-vision/http';

/** Checks the printer's camera picture now, with the method in the settings. */
export const POST = api(async ({ params, request }, rt) => {
	const check = await visionOf(rt).checkNow(params.id!, request.signal);
	return { check, overview: visionOf(rt).overview(params.id!) };
});
