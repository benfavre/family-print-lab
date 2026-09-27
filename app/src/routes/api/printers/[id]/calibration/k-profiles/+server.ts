import { api, readJson } from '$lib/server/http';
import { calibrationOf } from '$lib/server/modules/slicer-calibration/api';

/** The flow dynamics (K-value) profiles saved on the printer, optionally for one filament. */
export const GET = api(({ params, url }, rt) =>
	calibrationOf(rt).kProfiles(params.id!, {
		...(url.searchParams.get('filamentId')
			? { filamentId: url.searchParams.get('filamentId') }
			: {})
	})
);

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
