import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import {
	authContext,
	authService,
	isSecure,
	startSession
} from '$lib/server/modules/lan-auth/http';
import { safeNext } from '$lib/server/modules/lan-auth/page';

/** Logs in with the household password or a profile PIN (throttled). */
export const POST = api(async (event, rt) => {
	const input = await readJson(event.request, 10_000);
	const ctx = authContext(event);
	const result = await authService(rt).login(input, { ip: ctx.ip, userAgent: ctx.userAgent });
	startSession(event.cookies, result, isSecure(event));
	const next = (input as { next?: unknown }).next;
	return json({
		ok: true,
		kid: !!result.kidProfileId,
		next: result.kidProfileId ? '/kid' : safeNext(typeof next === 'string' ? next : null)
	});
});
