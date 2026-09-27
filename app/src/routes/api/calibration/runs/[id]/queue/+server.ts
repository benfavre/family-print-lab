import { api, readJson } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

/** Adds the test's job to the print queue. */
export const POST = api(async ({ params, request }, rt) =>
	calibrationOf(rt).enqueue(params.id!, await readJson(request))
);
