// Helpers the auth handle and the /login and /api/auth routes share: cookies, the service, the
// request's auth context.
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '../../runtime';
import { setKidCookie } from '../../kid/session';
import { AppError } from '../../validation';
import { SESSION_COOKIE, SESSION_DAYS } from './sessions';
import type { AuthContext, LanAuth } from './service';

export function setSessionCookie(cookies: Cookies, token: string, secure: boolean) {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: SESSION_DAYS * 24 * 60 * 60
	});
}

/**
 * `secure` must match how the cookie was set: SvelteKit otherwise marks the deletion Secure (it trusts
 * adapter-node's https guess), and a browser ignores a Secure Set-Cookie over plain http.
 */
export function clearSessionCookie(cookies: Cookies, secure: boolean) {
	cookies.delete(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure });
}

/** After a login: the session cookie, and kid mode when the PIN was a kid's. */
export function startSession(
	cookies: Cookies,
	o: { token: string; kidProfileId?: string | null },
	secure: boolean
) {
	setSessionCookie(cookies, o.token, secure);
	if (o.kidProfileId) setKidCookie(cookies, o.kidProfileId, secure);
}

export function authService(rt: Runtime): LanAuth {
	const service = rt.module('lan-auth');
	if (!service) throw new AppError(503, 'Login for other devices is not available right now.');
	return service;
}

/** The auth handle always sets this; the fallback (another device, no session) is the safe side. */
export function authContext(event: Pick<RequestEvent, 'locals'>): AuthContext {
	return event.locals.auth ?? { local: false, session: null, ip: '', userAgent: '' };
}

/**
 * Whether the browser reached the app over HTTPS, for the cookies' Secure flag. adapter-node assumes
 * https unless ORIGIN or PROTOCOL_HEADER says otherwise, and a Secure cookie on plain http to a LAN
 * name is dropped by the browser, so trust the scheme of the Origin the browser sent when there is
 * one, else the URL only when the server was told its protocol.
 */
export function isSecure(
	event: Pick<RequestEvent, 'url' | 'request'>,
	env: Record<string, string | undefined> = process.env
): boolean {
	const origin = event.request.headers.get('origin');
	if (origin && origin !== 'null') return origin.startsWith('https:');
	return event.url.protocol === 'https:' && !!(env.ORIGIN || env.PROTOCOL_HEADER);
}

/**
 * Whether isSecure really knows the scheme (an Origin header, or ORIGIN / PROTOCOL_HEADER). A page
 * load carries no Origin, so renewing the cookie there could drop the Secure flag of a cookie set
 * over HTTPS; the auth handle renews it only when this is true.
 */
export function knowsScheme(
	event: Pick<RequestEvent, 'request'>,
	env: Record<string, string | undefined> = process.env
): boolean {
	const origin = event.request.headers.get('origin');
	return (!!origin && origin !== 'null') || !!(env.ORIGIN || env.PROTOCOL_HEADER);
}
