import { api, readJson } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

/** Starts the printer's own flow dynamics or flow rate calibration for some trays. */
export const POST = api(async ({ params, request }, rt) =>
	calibrationOf(rt).startOnPrinter(params.id!, await readJson(request))
);
