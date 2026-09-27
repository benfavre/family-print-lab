import { z } from 'zod';
import { api } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';
import { parse } from '$lib/server/validation';
import { MODEL_CODES } from '$lib/shared/printers/models';

const query = z.object({
	model: z.enum(MODEL_CODES),
	nozzle: z.string().max(10).default('0.4'),
	material: z.string().max(80).optional()
});

/** The default printer, process and filament presets for ?model, ?nozzle and ?material. */
export const GET = api(({ url }, rt) => {
	const q = parse(query, Object.fromEntries(url.searchParams));
	return profilesOf(rt).profiles.defaults(q.model, q.nozzle, q.material);
});
