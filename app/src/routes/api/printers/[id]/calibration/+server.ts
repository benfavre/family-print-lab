import { api } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

/** What this printer can calibrate itself, its nozzle and its trays. */
export const GET = api(({ params }, rt) => calibrationOf(rt).info(params.id!));
