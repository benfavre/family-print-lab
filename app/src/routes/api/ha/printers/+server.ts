import { json } from '@sveltejs/kit';
import { api } from '$lib/server/http';
import { homeAutomation } from '$lib/server/modules/home-automation/service';
import { allowed } from '$lib/server/modules/home-automation/access';

/**
 * Printers as flat, sensor-friendly JSON for Home Assistant's REST sensors. Needs the token from
 * Integrations → Home automation (Authorization: Bearer …) unless the request comes from this computer.
 */
export const GET = api((event, rt) => {
	const ha = homeAutomation(rt);
	const s = ha.settings();
	if (!s.ha.enabled) return json({ error: 'Home Assistant access is off.' }, { status: 404 });
	if (!allowed(event, s.tokenHash))
		return json(
			{ error: 'Send the access token from Integrations → Home automation.' },
			{ status: 401, headers: { 'www-authenticate': 'Bearer realm="Family Print Lab"' } }
		);
	return { printers: ha.haPrinters() };
});
