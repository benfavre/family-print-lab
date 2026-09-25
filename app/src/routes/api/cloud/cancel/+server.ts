import { api } from '$lib/server/http';

/** Stops waiting for a code to be entered. */
export const POST = api((_, rt) => {
	rt.cloud?.cancelLink();
	return { ok: true };
});
