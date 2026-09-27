import { api, readJson } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

/** The value picked from the print, saved into a user filament preset and the spool. */
export const POST = api(async ({ params, request }, rt) =>
	calibrationOf(rt).setResult(params.id!, await readJson(request))
);
