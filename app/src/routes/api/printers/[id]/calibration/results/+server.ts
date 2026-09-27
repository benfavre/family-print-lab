import { api } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

/** The printer's last calibration results (?kind=pa or flow; ?extruderId=1 for the left nozzle's size). */
export const GET = api(({ params, url }, rt) => {
	const extruderId = url.searchParams.get('extruderId');
	return calibrationOf(rt).resultsOnPrinter(params.id!, {
		kind: url.searchParams.get('kind') ?? 'pa',
		...(extruderId ? { extruderId: Number(extruderId) } : {})
	});
});
