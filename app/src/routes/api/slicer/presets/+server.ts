import { api, readJson } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';

/** Your own presets. */
export const GET = api((_e, rt) => profilesOf(rt).store.list());

/** Creates a preset: { kind, name, from (the preset to start from), config (changed keys) }. */
export const POST = api(async ({ request }, rt) => ({
	preset: profilesOf(rt).createUser(await readJson(request))
}));
