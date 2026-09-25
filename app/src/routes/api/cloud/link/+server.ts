import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';

/** Starts linking: returns a code for a grown-up to enter on the cloud site. */
export const POST = api(async (_, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	return rt.cloud.link();
});
