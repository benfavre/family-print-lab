import { api, readJson } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';

/** The filament preset a spool slices with. */
export const GET = api(({ params }, rt) => ({ preset: profilesOf(rt).spoolPreset(params.id!) }));

/** Sets it: { preset: PresetRef | null }. */
export const PUT = api(async ({ request, params }, rt) => ({
	preset: profilesOf(rt).setSpoolPreset(params.id!, await readJson(request))
}));
