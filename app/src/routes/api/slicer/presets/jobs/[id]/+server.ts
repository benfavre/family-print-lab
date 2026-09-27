import { api, readJson } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';

/** What the job slices with: its choices, the presets they resolve to and what it may pick from. */
export const GET = api(({ params }, rt) => profilesOf(rt).jobView(params.id!));

/** Replaces the job's slicer settings: { printer?, process?, filaments?, overrides? }. */
export const PUT = api(async ({ request, params }, rt) => {
	const lab = profilesOf(rt);
	lab.setJobSettings(params.id!, await readJson(request, 2_000_000));
	return { view: lab.jobView(params.id!) };
});
