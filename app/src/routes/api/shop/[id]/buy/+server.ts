import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';

/** Buys with the linked account's credits (kid mode cannot reach this). */
export const POST = api(async ({ params }, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	return rt.cloud.buy(params.id ?? '');
});
