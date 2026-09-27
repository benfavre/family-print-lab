import { api, readJson } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

export const GET = api((_e, rt) => calibrationOf(rt).runs());

/** Starts a test: slices it for the printer and filament, then queues a job with it. */
export const POST = api(async ({ request }, rt) =>
	calibrationOf(rt).create(await readJson(request))
);
