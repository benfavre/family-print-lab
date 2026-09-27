import { api, readJson } from '$lib/server/http';
import { homeAutomation } from '$lib/server/modules/home-automation/service';

/** Home automation settings, without the MQTT password or the token. */
export const GET = api((_, rt) => homeAutomation(rt).view());

/** Turns Home Assistant access, metrics or MQTT on or off and changes the broker settings. */
export const PATCH = api(async ({ request }, rt) => ({
	settings: homeAutomation(rt).updateSettings(await readJson(request))
}));
