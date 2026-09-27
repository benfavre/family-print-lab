// The login handle (lan-auth), between crossSiteGuard and kidGuard. It works out whether the request
// comes from this computer, finds its session, and sends anyone who needs to log in to /login (pages)
// or answers 401 (API, including the live events stream). See modules/lan-auth/decide.ts for the rules.
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { EventEmitter } from 'node:events';
import { runtime } from '../runtime';
import { profiles } from '../db/schema';
import { KID_COOKIE, setKidCookie } from '../kid/session';
import { authDecision, isLocalRequest } from '../modules/lan-auth/decide';
import { PAGE_CSP, setupPage } from '../modules/lan-auth/page';
import { SESSION_COOKIE } from '../modules/lan-auth/sessions';
import { isSecure, setSessionCookie } from '../modules/lan-auth/http';
import type { AuthContext } from '../modules/lan-auth/service';

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace -- SvelteKit declares App.Locals this way
	namespace App {
		interface Locals {
			/** Set by the auth handle: where the request came from and its login session. */
			auth?: AuthContext;
		}
	}
}

export function clientAddress(event: Pick<RequestEvent, 'getClientAddress'>): string {
	try {
		return event.getClientAddress();
	} catch {
		return ''; // unknown counts as another device
	}
}

const BASE_HEADERS = {
	'x-content-type-options': 'nosniff',
	'cache-control': 'no-store',
	'referrer-policy': 'no-referrer'
};

function refuse(status: number, error: string) {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { ...BASE_HEADERS, 'content-type': 'application/json' }
	});
}

export const auth: Handle = async ({ event, resolve }) => {
	const rt = runtime();
	const service = rt.module('lan-auth');
	const ip = clientAddress(event);
	const local = isLocalRequest(ip, event.url.hostname);
	const found = service?.sessions.find(event.cookies.get(SESSION_COOKIE), { ip }) ?? null;
	const secure = isSecure(event);
	if (found?.touched) setSessionCookie(event.cookies, event.cookies.get(SESSION_COOKIE)!, secure);
	event.locals.auth = {
		local,
		session: found?.row ?? null,
		ip,
		userAgent: event.request.headers.get('user-agent') ?? ''
	};

	const { pathname } = event.url;
	const decision = authDecision({
		pathname,
		local,
		session: !!found,
		settings: service?.settings() ?? null
	});
	const api = pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(event.request.method);
	if (decision === 'login') {
		if (api) return refuse(401, 'Log in first.');
		const next = pathname + event.url.search;
		return new Response(null, {
			status: 303,
			headers: { ...BASE_HEADERS, location: `/login?next=${encodeURIComponent(next)}` }
		});
	}
	if (decision === 'setup') {
		if (api) return refuse(403, 'Set a password on the computer first.');
		return new Response(setupPage(), {
			status: 403,
			headers: {
				...BASE_HEADERS,
				'content-type': 'text/html; charset=utf-8',
				'content-security-policy': PAGE_CSP
			}
		});
	}
	if (decision === 'unavailable') return refuse(503, 'Open Print Lab on the computer it runs on.');

	// A kid who logged in with their own PIN stays in kid mode even if the kid cookie goes missing;
	// only the parent PIN (which releases the session below) lets this device out.
	const profileId = found?.row.profileId;
	if (profileId && !event.cookies.get(KID_COOKIE)) {
		const kid = rt.db
			.select({ kid: profiles.kid })
			.from(profiles)
			.where(eq(profiles.id, profileId))
			.get()?.kid;
		if (kid) setKidCookie(event.cookies, profileId, secure);
	}

	const response = await resolve(event);
	if (!found || !service) return response;
	if (profileId && pathname === '/api/kid/exit' && event.request.method === 'POST' && response.ok)
		service.sessions.release(found.row.id);
	// Logging a device out also closes its live updates stream.
	if ((response.headers.get('content-type') ?? '').startsWith('text/event-stream') && response.body)
		return closeWhenEnded(response, found.row.id, service.sessions.events);
	return response;
};

/** Passes a streamed response through until session `id` is logged out. */
export function closeWhenEnded(response: Response, id: string, events: EventEmitter): Response {
	const reader = response.body!.getReader();
	let off = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const onEnded = (ids: string[]) => {
				if (!ids.includes(id)) return;
				off();
				reader.cancel().catch(() => {});
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			events.on('ended', onEnded);
			off = () => events.off('ended', onEnded);
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					off();
					controller.close();
				} else controller.enqueue(value);
			} catch {
				off();
			}
		},
		cancel(reason) {
			off();
			return reader.cancel(reason);
		}
	});
	return new Response(stream, { status: response.status, headers: response.headers });
}
