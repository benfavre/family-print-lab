import { api } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

/** The printer's last calibration results (?kind=pa or flow). */
export const GET = api(({ params, url }, rt) =>
	calibrationOf(rt).resultsOnPrinter(params.id!, { kind: url.searchParams.get('kind') ?? 'pa' })
);
