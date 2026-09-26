import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';

/** { ids } in the new order. */
export const POST = api(async ({ request }, rt) => {
	const { ids } = parse(
		z.object({ ids: z.array(z.string().max(80)).max(100) }),
		await readJson(request)
	);
	rt.printers.reorder(ids);
	return { ok: true };
});
