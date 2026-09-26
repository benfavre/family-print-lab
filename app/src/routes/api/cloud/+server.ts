import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { CLOUD_OFF } from '$lib/shared/cloud';

/** The Print Lab Cloud link's status (see docs/cloud-protocol.md). */
export const GET = api((_, rt) => rt.cloud?.status() ?? CLOUD_OFF);

/** Settings: whether kids' first names are sent with their requests, and the printer's progress. */
export const PATCH = api(async ({ request }, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	const { shareNames, shareProgress } = parse(
		z.strictObject({ shareNames: z.boolean().optional(), shareProgress: z.boolean().optional() }),
		await readJson(request)
	);
	if (shareNames !== undefined) rt.cloud.setShareNames(shareNames);
	if (shareProgress !== undefined) rt.cloud.setShareProgress(shareProgress);
	return rt.cloud.status();
});
