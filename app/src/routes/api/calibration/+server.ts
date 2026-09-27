import { api } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

/** The tests the slicer can make, the runs so far and where their prints go. */
export const GET = api((_e, rt) => calibrationOf(rt).overview());
