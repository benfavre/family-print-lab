import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { CLOUD_OFF } from '$lib/shared/cloud';

/** The Print Lab Cloud link's status (see docs/cloud-protocol.md). */
export const GET = api((_, rt) => rt.cloud?.status() ?? CLOUD_OFF);

/** Settings: whether kids' first names are sent with their requests. */
export const PATCH = api(async ({ request }, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	const { shareNames } = parse(
		z.strictObject({ shareNames: z.boolean() }),
		await readJson(request)
	);
	rt.cloud.setShareNames(shareNames);
	return rt.cloud.status();
});
