import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import type { CommandName } from '$lib/server/printer/commands/registry';

/** Runs one typed printer command ({ name, params }; see printer/commands/). */
export const POST = api(async ({ request, params }, rt) => {
	const body = parse(
		z.object({
			name: z.string().max(80),
			params: z.record(z.string(), z.unknown()).default({})
		}),
		await readJson(request, 100_000)
	);
	const outcome = await rt.printers.require(params.id!).send(body.name as CommandName, body.params);
	return new Response(JSON.stringify(outcome), { headers: { 'content-type': 'application/json' } });
});
