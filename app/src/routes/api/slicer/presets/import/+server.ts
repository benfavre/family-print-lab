import { api } from '$lib/server/http';
import { readBinary } from '$lib/server/cad/requests';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';

/** Imports Bambu Studio presets: a .json, .bbscfg, .bbsflmt or .zip (raw body; ?name= the file name). */
export const POST = api(async ({ request, url }, rt) => {
	const data = await readBinary(request, 5_000_000);
	return profilesOf(rt).importFile({ name: url.searchParams.get('name') ?? 'preset.json', data });
});
