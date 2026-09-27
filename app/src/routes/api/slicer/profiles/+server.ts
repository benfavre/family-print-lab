import { z } from 'zod';
import { api } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';
import { presetKind } from '$lib/server/modules/slicer-profiles/validation';
import { parse } from '$lib/server/validation';
import { MODEL_CODES } from '$lib/shared/printers/models';

const listQuery = z.object({
	kind: presetKind,
	printer: z.string().max(200).optional(),
	model: z.enum(MODEL_CODES).optional(),
	nozzle: z.string().max(10).optional(),
	hidden: z.enum(['0', '1']).optional()
});

/**
 * Without ?kind: where the system presets come from, the printer models they cover and the user's
 * presets. With ?kind=printer|process|filament: that kind's presets, filtered by ?printer (a printer
 * preset name) or ?model and ?nozzle; ?hidden=1 adds the base presets.
 */
export const GET = api(({ url }, rt) => {
	const lab = profilesOf(rt);
	if (!url.searchParams.has('kind')) return lab.overview();
	const q = parse(listQuery, Object.fromEntries(url.searchParams));
	return lab.profiles.list(q.kind, {
		printer: q.printer,
		model: q.model,
		nozzle: q.nozzle,
		includeHidden: q.hidden === '1'
	});
});
