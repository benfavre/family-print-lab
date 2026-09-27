import { api } from '$lib/server/http';
import { needKids } from '$lib/server/modules/kids/api';

/** Takes a photo now with the camera of the printer that made this print (needs a camera). */
export const POST = api(async ({ params }, rt) => ({
	item: await needKids(rt).captureNow(params.jobId!)
}));
