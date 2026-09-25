import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';

const overrides = z.strictObject({
	notes: z.string().max(4000).optional(),
	layerHeight: z.string().max(20).optional(),
	nozzle: z.string().max(20).optional(),
	plate: z.string().max(60).optional(),
	supports: z.enum(['None', 'Normal', 'Tree']).optional(),
	infill: z.number().int().min(0).max(100).nullable().optional()
});

export const POST = api(async ({ request, params }, rt) => ({
	id: rt.lab.reprintJob(params.id!, parse(overrides, await readJson(request)))
}));
