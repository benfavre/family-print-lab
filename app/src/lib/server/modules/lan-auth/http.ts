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

export function clearSessionCookie(cookies: Cookies) {
	cookies.delete(SESSION_COOKIE, { path: '/' });
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

export const isSecure = (event: Pick<RequestEvent, 'url'>) => event.url.protocol === 'https:';
