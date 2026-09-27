// The login page for other devices (lan-auth). Plain HTML and a form post: see modules/lan-auth/page.ts
// for why it does not use the app layout.
import type { RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import { AppError } from '$lib/server/validation';
import { authDecision } from '$lib/server/modules/lan-auth/decide';
import { loginPage, PAGE_CSP, safeNext, setupPage } from '$lib/server/modules/lan-auth/page';
import { authContext, isSecure, startSession } from '$lib/server/modules/lan-auth/http';

function html(body: string, status = 200) {
	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy': PAGE_CSP,
			'cache-control': 'no-store'
		}
	});
}

const go = (location: string) => new Response(null, { status: 303, headers: { location } });

export const GET: RequestHandler = (event) => {
	const service = runtime().module('lan-auth');
	const next = safeNext(event.url.searchParams.get('next'));
	if (!service) return go(next);
	const ctx = authContext(event);
	// Only the answer for the rest of the app matters here: open or logged in means go on.
	const decision = authDecision({
		pathname: '/',
		local: ctx.local,
		session: !!ctx.session,
		settings: service.settings()
	});
	if (decision === 'allow') return go(next);
	if (decision === 'setup') return html(setupPage(), 403);
	return html(loginPage({ mode: service.mode(), next }));
};

export const POST: RequestHandler = async (event) => {
	const service = runtime().module('lan-auth');
	const form = await event.request.formData().catch(() => null);
	const next = safeNext(form?.get('next')?.toString());
	if (!service) return go(next);
	const ctx = authContext(event);
	try {
		const result = await service.login(
			{ secret: form?.get('secret')?.toString() ?? '' },
			{ ip: ctx.ip, userAgent: ctx.userAgent }
		);
		startSession(event.cookies, result, isSecure(event));
		return go(result.kidProfileId ? '/kid' : next);
	} catch (error) {
		if (!(error instanceof AppError)) throw error;
		if (error.status === 409) return html(setupPage(), 403);
		return html(loginPage({ mode: service.mode(), next, error: error.message }), error.status);
	}
};
