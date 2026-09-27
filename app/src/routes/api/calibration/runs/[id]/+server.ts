import { api } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

export const GET = api(({ params }, rt) => calibrationOf(rt).get(params.id!));

export const DELETE = api(({ params }, rt) => {
	calibrationOf(rt).remove(params.id!);
	return { ok: true };
});
