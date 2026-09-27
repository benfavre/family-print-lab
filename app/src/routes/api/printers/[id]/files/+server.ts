import { api } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { cameraOf } from '$lib/server/modules/camera/http';
import { mediaDirQuery } from '$lib/server/modules/camera/validation';

/** A folder on the printer's storage (default /timelapse), as a MediaListing. */
export const GET = api(({ params, url, request }, rt) => {
	const dir = parse(mediaDirQuery, url.searchParams.get('dir') ?? undefined);
	return cameraOf(rt).media.list(rt.printers.require(params.id!), dir, request.signal);
});
