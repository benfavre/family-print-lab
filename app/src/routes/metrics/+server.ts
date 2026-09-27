import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { allowed } from '$lib/server/modules/home-automation/access';
import { METRICS_CONTENT_TYPE } from '$lib/server/modules/home-automation/export';

/**
 * Prometheus metrics (text format): printer state, temperatures, progress, AMS humidity, job counts.
 * Off until switched on in Integrations → Home automation; then this computer may read them, and other
 * machines with the access token (Authorization: Bearer …).
 */
export const GET: RequestHandler = (event) => {
	const ha = runtime().module('home-automation');
	const text = (status: number, body: string, headers: Record<string, string> = {}) =>
		new Response(body, {
			status,
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store',
				...headers
			}
		});
	const s = ha?.settings();
	if (!ha || !s?.metrics.enabled) return text(404, 'Metrics are off.\n');
	if (!allowed(event, s.tokenHash))
		return text(401, 'Send the access token from Integrations → Home automation.\n', {
			'www-authenticate': 'Bearer realm="Family Print Lab"'
		});
	return text(200, ha.metrics(), { 'content-type': METRICS_CONTENT_TYPE });
};
