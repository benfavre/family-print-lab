import { api, readJson } from '$lib/server/http';
import { notifications } from '$lib/server/modules/notifications/api';

/** Sends a test message to one channel (`{ channel }`, as the form has it). */
export const POST = api(async ({ request }, rt) => ({
	result: await notifications(rt).test(await readJson(request))
}));
