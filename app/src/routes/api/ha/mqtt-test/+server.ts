import { api, readJson } from '$lib/server/http';
import { homeAutomation } from '$lib/server/modules/home-automation/service';

/** Connects to the broker once with the settings in the form (a blank password uses the saved one). */
export const POST = api(async ({ request }, rt) =>
	homeAutomation(rt).testMqtt(await readJson(request))
);
