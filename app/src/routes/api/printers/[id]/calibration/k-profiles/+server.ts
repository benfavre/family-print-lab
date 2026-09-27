import { api, readJson } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

/**
 * The flow dynamics (K-value) profiles saved on the printer for a nozzle size (?extruderId=1 for the
 * left nozzle's), optionally for one filament (?filamentId=).
 */
export const GET = api(({ params, url }, rt) => {
	const filamentId = url.searchParams.get('filamentId');
	const extruderId = url.searchParams.get('extruderId');
	return calibrationOf(rt).kProfiles(params.id!, {
		...(filamentId ? { filamentId } : {}),
		...(extruderId ? { extruderId: Number(extruderId) } : {})
	});
});

/** Saves a profile (new, or `caliIdx` to replace one). */
export const POST = api(async ({ params, request }, rt) =>
	calibrationOf(rt).saveKProfile(params.id!, await readJson(request))
);

/** Picks a profile for a tray. */
export const PUT = api(async ({ params, request }, rt) =>
	calibrationOf(rt).selectKProfile(params.id!, await readJson(request))
);

export const DELETE = api(async ({ params, request }, rt) =>
	calibrationOf(rt).deleteKProfile(params.id!, await readJson(request))
);
