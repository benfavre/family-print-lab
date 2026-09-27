import { api, readJson } from '$lib/server/http';
import { homeAutomation } from '$lib/server/modules/home-automation/service';
import { plugView } from '$lib/server/modules/home-automation/store';

/** Smart plugs (never their passwords or tokens) and what the app knows of each one's state. */
export const GET = api((_, rt) => {
	const ha = homeAutomation(rt);
	return { plugs: ha.plugs.list().map(plugView), states: ha.powerStates() };
});

/** Adds a plug to a printer. */
export const POST = api(async ({ request }, rt) => {
	const plug = homeAutomation(rt).plugs.create(await readJson(request));
	return { plug: plugView(plug) };
});
