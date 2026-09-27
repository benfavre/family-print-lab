import { z } from 'zod';
import { api } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';
import { parse } from '$lib/server/validation';

const query = z.object({
	printer: z.string().min(1).max(80),
	tray: z.coerce.number().int().min(0).max(65535)
});

/** The filament preset for what a printer's tray holds (by its Bambu filament id), or null. */
export const GET = api(({ url }, rt) => {
	const q = parse(query, Object.fromEntries(url.searchParams));
	return { preset: profilesOf(rt).filamentForTray(q.printer, q.tray) };
});
