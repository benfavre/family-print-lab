import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';

/** Pause, resume or stop this printer's print. */
export const POST = api(async ({ request, params }, rt) => {
	const { action } = parse(
		z.object({ action: z.enum(['pause', 'resume', 'stop']) }),
		await readJson(request)
	);
	return { outcome: await rt.printers.require(params.id!).control(action) };
});
