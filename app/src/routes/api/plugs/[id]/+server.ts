import { api, readJson } from '$lib/server/http';
import { homeAutomation } from '$lib/server/modules/home-automation/service';
import { plugView } from '$lib/server/modules/home-automation/store';

/** Changes a plug (versioned); an empty password or token keeps the saved one, null clears it. */
export const PATCH = api(async ({ request, params }, rt) => {
	const plug = homeAutomation(rt).plugs.update(params.id!, await readJson(request));
	return { plug: plugView(plug) };
});

export const DELETE = api(({ params }, rt) => {
	homeAutomation(rt).plugs.remove(params.id!);
	return { ok: true };
});
