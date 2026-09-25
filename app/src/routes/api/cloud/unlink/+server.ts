import { api } from '$lib/server/http';

/** Unlinks this computer from Print Lab Cloud. */
export const POST = api(async (_, rt) => {
	await rt.cloud?.unlink();
	return { ok: true };
});
