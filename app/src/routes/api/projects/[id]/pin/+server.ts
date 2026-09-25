import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';

export const PUT = api(async ({ request, params }, rt) =>
	rt.lab.setPinned(
		params.id!,
		parse(z.strictObject({ pinned: z.boolean() }), await readJson(request)).pinned
	)
);
