import { api, readJson } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';

export const GET = api(({ params }, rt) =>
	profilesOf(rt).detail({
		kind: profilesOf(rt).profiles.userPreset(params.id!).kind,
		name: 'user',
		source: 'user',
		userPresetId: params.id
	})
);

/** Renames and/or replaces the changed keys: { version, name?, config? }. */
export const PATCH = api(async ({ request, params }, rt) => ({
	preset: profilesOf(rt).updateUser(params.id!, await readJson(request, 2_000_000))
}));

export const DELETE = api(({ params }, rt) => {
	profilesOf(rt).removeUser(params.id!);
	return {};
});
