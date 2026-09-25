import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';

const body = z.strictObject({
	plate: z.number().int().min(1).max(200).optional(),
	useAms: z.boolean(),
	amsMapping: z.array(z.number().int().min(-1).max(255)).max(32),
	bedLeveling: z.boolean().optional(),
	timelapse: z.boolean().optional(),
	force: z.boolean().optional(),
	/** Only check; do not send. */
	check: z.boolean().optional()
});

/** Checks, or sends a queued job's sliced file to the printer and starts it (a background task). */
export const POST = api(async ({ request, params }, rt) => {
	const { check, ...opts } = parse(body, await readJson(request));
	if (check) return { check: rt.printing.check(params.id!, opts) };
	return { task: rt.printing.send(params.id!, opts) };
});
