import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';

/** Listens for printers on the network for a few seconds ({ ms? } up to 15 s). */
export const POST = api(async ({ request }, rt) => {
	const { ms } = parse(
		z.object({ ms: z.number().int().min(500).max(15_000).optional() }),
		await readJson(request)
	);
	const result = await rt.printers.discoverDetailed({ ms });
	return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
});
