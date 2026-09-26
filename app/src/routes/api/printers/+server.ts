import { api, readJson } from '$lib/server/http';

/** Every saved printer's live status, in Settings order. */
export const GET = api((_e, rt) => rt.printers.statuses());

/** Adds a printer (Settings → Printers). */
export const POST = api(async ({ request }, rt) => ({
	printer: rt.printers.create(await readJson(request))
}));
