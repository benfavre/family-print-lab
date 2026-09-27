import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { logoutInput } from '$lib/server/modules/lan-auth/validation';
import { authContext, authService, clearSessionCookie } from '$lib/server/modules/lan-auth/http';

/** Logs this browser out, or every device with `everywhere`. */
export const POST = api(async (event, rt) => {
	const { everywhere } = parse(logoutInput, await readJson(event.request, 10_000));
	authService(rt).logout(authContext(event), everywhere);
	clearSessionCookie(event.cookies);
	return json({ ok: true });
});
