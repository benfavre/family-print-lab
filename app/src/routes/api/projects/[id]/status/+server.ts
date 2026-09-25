import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { PROJECT_STATUSES } from '$lib/shared/domain';

export const PUT = api(async ({ request, params }, rt) =>
	rt.lab.setProjectStatus(
		params.id!,
		parse(z.strictObject({ status: z.enum(PROJECT_STATUSES) }), await readJson(request)).status
	)
);
