import { api } from '$lib/server/http';
import { homeAutomation } from '$lib/server/modules/home-automation/service';

/** A new access token for Home Assistant and remote metrics, shown this once (only its hash is kept). */
export const POST = api((_, rt) => {
	const ha = homeAutomation(rt);
	return { token: ha.createToken(), settings: ha.view() };
});

/** Stops the token working. */
export const DELETE = api((_, rt) => {
	const ha = homeAutomation(rt);
	ha.revokeToken();
	return { settings: ha.view() };
});
