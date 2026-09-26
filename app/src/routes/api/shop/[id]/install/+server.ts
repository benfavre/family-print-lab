import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { install } from '$lib/server/shop';

/** Installs something bought: a kid pack, or a project for `profileId` with the part or model. */
export const POST = api(async ({ params, request }, rt) => {
	const { profileId } = parse(
		z.strictObject({ profileId: z.string().max(80) }),
		await readJson(request)
	);
	return install(rt, params.id ?? '', profileId);
});
