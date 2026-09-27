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
	const service = authService(rt);
	const result = await service.login(input, { ip: ctx.ip, userAgent: ctx.userAgent });
	// Logging in again replaces this browser's old session rather than leaving it in the list.
	if (ctx.session) service.sessions.end(ctx.session.id);
	startSession(event.cookies, result, isSecure(event));
	const next = (input as { next?: unknown }).next;
	return json({
		ok: true,
		kid: !!result.kidProfileId,
		next: result.kidProfileId ? '/kid' : safeNext(typeof next === 'string' ? next : null)
	});
});
