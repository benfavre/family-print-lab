import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { commandDef, type CommandName } from '$lib/server/printer/commands/registry';
import { AppError } from '$lib/server/validation';

/** Runs one typed printer command ({ name, params }; see printer/commands/). */
export const POST = api(async ({ request, params }, rt) => {
	const body = parse(
		z.object({
			name: z.string().max(80),
			params: z.record(z.string(), z.unknown()).default({})
		}),
		await readJson(request, 100_000)
	);
	// The raw forms the app sends itself (pushall, get_version, unguarded G-code) are not for callers.
	if (commandDef(body.name)?.internal)
		throw new AppError(400, 'That printer command is not available here.');
	const outcome = await rt.printers.require(params.id!).send(body.name as CommandName, body.params);
	return new Response(JSON.stringify(outcome), { headers: { 'content-type': 'application/json' } });
});
