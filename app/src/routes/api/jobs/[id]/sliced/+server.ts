import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { readBinary } from '$lib/server/cad/requests';
import { MAX_SLICED_BYTES } from '$lib/server/printing';
import { parse } from '$lib/server/validation';

/** Attaches a sliced .gcode.3mf (raw body; ?name= the original file name) to a queued job. */
export const POST = api(async ({ request, params, url }, rt) => {
	const data = await readBinary(request, MAX_SLICED_BYTES);
	return { sliced: rt.printing.attach(params.id!, data, url.searchParams.get('name') ?? '') };
});

/** Chooses which plate of the file this job prints. */
export const PATCH = api(async ({ request, params }, rt) => {
	const { plate } = parse(
		z.object({ plate: z.number().int().min(1).max(200) }),
		await readJson(request)
	);
	rt.printing.choosePlate(params.id!, plate);
	return {};
});

export const DELETE = api(({ params }, rt) => {
	rt.printing.detach(params.id!);
	return {};
});
