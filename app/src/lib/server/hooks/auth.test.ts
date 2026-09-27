// The auth handle over a test lab with the lan-auth module: who gets through, the login page and
// form, the setup page, kid PIN logins and the kid-mode interplay, CSRF, and live streams closing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../testing/harness';
import { ParentPin } from '../kid/pin';
import { KID_COOKIE } from '../kid/session';
import { eq } from 'drizzle-orm';
import { sessions } from '../db/schema';
import { SESSION_COOKIE, tokenHash } from '../modules/lan-auth/sessions';
import type { LanAuth } from '../modules/lan-auth/service';
import { isSecure } from '../modules/lan-auth/http';
import { auth } from './auth';
import { crossSiteGuard, kidGuard } from './index';
import { GET as loginGet, POST as loginPost } from '../../../routes/login/+server';
import { POST as logoutPost } from '../../../routes/api/auth/logout/+server';
import { POST as kidEnter } from '../../../routes/api/kid/enter/+server';
import { POST as kidExit } from '../../../routes/api/kid/exit/+server';

let t: TestLab, service: LanAuth;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	t = await startTestLab({ modules: ['lan-auth'], fleet: [] });
	holder[key] = t.rt;
	service = t.rt.module('lan-auth')!;
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

const HERE = { local: true, session: null, ip: '127.0.0.1', userAgent: '' };

beforeEach(async () => {
	// Back to "only this computer", nobody logged in, no wrong tries remembered.
	for (const k of ['ip:192.168.1.20', 'ip:127.0.0.1']) service.ipLimiter.reset(k);
	service.accountLimiter.reset('account');
	if (service.mode() !== 'off') await service.clearPassword({ current: 'correct horse' }, HERE);
});

/** A cookie jar that behaves like SvelteKit's (newly set cookies are visible to later gets). */
function jar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const sets: { name: string; secure: boolean }[] = [];
	const cookies = {
		get: (name: string) => values.get(name),
		getAll: () => [...values].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string, o: { secure: boolean }) => {
			values.set(name, value);
			sets.push({ name, secure: o.secure });
		},
		delete: (name: string, o: { secure: boolean }) => {
			values.delete(name);
			sets.push({ name, secure: o.secure });
		},
		serialize: () => ''
	} as unknown as Cookies;
	return { cookies, values, sets };
}

function event(
	url: string,
	o: {
		ip?: string;
		method?: string;
		cookies?: Record<string, string>;
		routeId?: string | null;
		body?: BodyInit;
		headers?: Record<string, string>;
	} = {}
) {
	const { cookies, values, sets } = jar(o.cookies);
	const u = new URL(url);
	const request = new Request(u, {
		method: o.method ?? 'GET',
		headers: { host: u.host, ...o.headers },
		body: o.body
	});
	const ev = {
		url: u,
		request,
		cookies,
		locals: { kid: null },
		params: {},
		route: { id: o.routeId === undefined ? u.pathname : o.routeId },
		getClientAddress: () => o.ip ?? '127.0.0.1'
	} as unknown as RequestEvent;
	return { ev, values, sets };
}

const ok = async () => new Response('ok');

async function through(url: string, o: Parameters<typeof event>[1] = {}) {
	const { ev, values, sets } = event(url, o);
	const res = await auth({ event: ev, resolve: ok });
	return { res, values, ev, sets };
}

async function setPassword(password = 'correct horse') {
	await service.setPassword({ password }, HERE);
}

describe('the auth handle', () => {
	it('changes nothing on this computer by default', async () => {
		for (const path of ['/', '/projects', '/api/workspace', '/api/events']) {
			const { res, ev } = await through(`http://localhost:5173${path}`);
			expect(await res.text()).toBe('ok');
			expect(ev.locals.auth).toMatchObject({ local: true, session: null });
		}
	});

	it('sends other devices to “set a password first” until there is one', async () => {
		const page = await through('http://printlab.local/', { ip: '192.168.1.20' });
		expect(page.res.status).toBe(403);
		expect(await page.res.text()).toMatch(/Set a password on the computer first/);
		const call = await through('http://printlab.local/api/workspace', { ip: '192.168.1.20' });
		expect(call.res.status).toBe(403);
		expect(await call.res.json()).toEqual({ error: 'Set a password on the computer first.' });
		// A LAN device spoofing Host: localhost is still another device.
		expect((await through('http://localhost/', { ip: '192.168.1.20' })).res.status).toBe(403);
	});

	it('asks other devices to log in once a password is set (pages redirect, API and SSE get 401)', async () => {
		await setPassword();
		const page = await through('http://printlab.local/jobs?x=1', { ip: '192.168.1.20' });
		expect(page.res.status).toBe(303);
		expect(page.res.headers.get('location')).toBe('/login?next=%2Fjobs%3Fx%3D1');
		for (const path of ['/api/workspace', '/api/events', '/api/auth']) {
			const call = await through(`http://printlab.local${path}`, { ip: '192.168.1.20' });
			expect(call.res.status).toBe(401);
		}
		expect((await through('http://printlab.local/login', { ip: '192.168.1.20' })).res.status).toBe(
			200
		);
		// This computer is still open.
		expect((await through('http://localhost/jobs')).res.status).toBe(200);
	});

	it('lets a device with a session in, and renews its cookie as it slides', async () => {
		await setPassword();
		const { token } = service.sessions.create({ profileId: null, userAgent: '', ip: '' });
		const { res, ev } = await through('http://printlab.local/api/workspace', {
			ip: '192.168.1.20',
			cookies: { [SESSION_COOKIE]: token }
		});
		expect(res.status).toBe(200);
		expect(ev.locals.auth?.session?.profileId).toBeNull();
		expect(
			(
				await through('http://printlab.local/api/workspace', {
					ip: '192.168.1.20',
					cookies: { [SESSION_COOKIE]: 'forged' }
				})
			).res.status
		).toBe(401);
	});

	it('asks this computer too with “Require login here too”', async () => {
		await setPassword();
		await service.update({ requireLocal: true, current: 'correct horse' }, HERE);
		expect((await through('http://localhost/')).res.status).toBe(303);
		expect((await through('http://localhost/api/workspace')).res.status).toBe(401);
	});
});

describe('the login page and form', () => {
	const form = (fields: Record<string, string>) => {
		const body = new URLSearchParams(fields);
		return {
			method: 'POST',
			ip: '192.168.1.20',
			body,
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		};
	};

	it('shows the form (one hashed script, strict CSP), then logs in and goes back where it was', async () => {
		await setPassword();
		const page = event('http://printlab.local/login?next=/jobs', { ip: '192.168.1.20' });
		page.ev.locals.auth = { local: false, session: null, ip: '192.168.1.20', userAgent: '' };
		const res = await loginGet(page.ev);
		const html = await res.text();
		expect(html).toMatch(/name="secret"/);
		expect(html.match(/<script/g)).toHaveLength(1);
		const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
		const hash = createHash('sha256').update(script).digest('base64');
		expect(res.headers.get('content-security-policy')).toContain(`script-src 'sha256-${hash}'`);
		expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);

		const wrong = event('http://printlab.local/login', form({ secret: 'nope', next: '/jobs' }));
		wrong.ev.locals.auth = { local: false, session: null, ip: '192.168.1.20', userAgent: '' };
		const bad = await loginPost(wrong.ev);
		expect(bad.status).toBe(403);
		expect(await bad.text()).toMatch(/That password or PIN is not right/);

		const right = event(
			'http://printlab.local/login',
			form({ secret: 'correct horse', next: '/jobs' })
		);
		right.ev.locals.auth = { local: false, session: null, ip: '192.168.1.20', userAgent: 'Safari' };
		const good = await loginPost(right.ev);
		expect(good.status).toBe(303);
		expect(good.headers.get('location')).toBe('/jobs');
		const token = right.values.get(SESSION_COOKIE)!;
		expect(service.sessions.find(token)?.row.userAgent).toBe('Safari');
	});

	it('never sends people off the app after logging in', async () => {
		await setPassword();
		for (const next of [
			'https://evil.example',
			'//evil.example',
			'/\\evil.example',
			// Browsers drop tabs and newlines, which would make these "//evil.example".
			'/\t/evil.example',
			'/\n/evil.example',
			'/\r\n/evil.example',
			'/api/export',
			'/login?next=//evil.example'
		]) {
			const r = event('http://printlab.local/login', form({ secret: 'correct horse', next }));
			r.ev.locals.auth = { local: false, session: null, ip: '192.168.1.20', userAgent: '' };
			expect((await loginPost(r.ev)).headers.get('location')).toBe('/');
		}
	});

	it('keeps a same-app next path as it was', async () => {
		await setPassword();
		const r = event(
			'http://printlab.local/login',
			form({ secret: 'correct horse', next: '/jobs?printer=p1#queue' })
		);
		r.ev.locals.auth = { local: false, session: null, ip: '192.168.1.20', userAgent: '' };
		expect((await loginPost(r.ev)).headers.get('location')).toBe('/jobs?printer=p1#queue');
	});

	it('replaces the old session when a browser logs in again', async () => {
		await setPassword();
		const old = service.sessions.create({ profileId: null, userAgent: '', ip: '' });
		const r = event('http://printlab.local/login', form({ secret: 'correct horse' }));
		r.ev.locals.auth = { local: false, session: old.row, ip: '192.168.1.20', userAgent: '' };
		expect((await loginPost(r.ev)).status).toBe(303);
		expect(service.sessions.find(old.token)).toBeNull();
		expect(service.sessions.find(r.values.get(SESSION_COOKIE))).not.toBeNull();
	});

	it('throttles brute force from the form', async () => {
		await setPassword();
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			const r = event('http://printlab.local/login', form({ secret: `guess${i}` }));
			r.ev.locals.auth = { local: false, session: null, ip: '192.168.1.20', userAgent: '' };
			statuses.push((await loginPost(r.ev)).status);
		}
		expect(statuses).toEqual([403, 403, 403, 403, 429, 429]);
	});
});

describe('kids and PINs', () => {
	it('a kid’s PIN logs straight into kid mode, and only the parent PIN lets the device out', async () => {
		await setPassword();
		if (!new ParentPin(t.rt.db).isSet()) t.rt.pin.set({ pin: '9999' });
		const kid = t.rt.lab.createProfile({ name: 'Ada', color: 'orange', age: 8, kid: 'junior' });
		await service.update({ profilePins: true }, HERE);
		await service.setPin(kid, { pin: '5678' }, HERE);

		const r = event('http://printlab.local/login', {
			method: 'POST',
			ip: '192.168.1.20',
			body: new URLSearchParams({ secret: '5678' }),
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		r.ev.locals.auth = { local: false, session: null, ip: '192.168.1.20', userAgent: '' };
		const res = await loginPost(r.ev);
		expect(res.headers.get('location')).toBe('/kid');
		expect(r.values.get(KID_COOKIE)).toBe(kid);
		const token = r.values.get(SESSION_COOKIE)!;

		// auth → kidGuard, as in HANDLES: the kid stays in kid pages, even without the kid cookie.
		const chain = async (url: string, cookies: Record<string, string>, method = 'GET') => {
			const { ev, values } = event(url, {
				ip: '192.168.1.20',
				cookies,
				method,
				routeId: new URL(url).pathname.startsWith('/api/') ? null : new URL(url).pathname,
				...(method === 'POST'
					? { body: '{"pin":"9999"}', headers: { 'content-type': 'application/json' } }
					: {})
			});
			const res = await auth({ event: ev, resolve: (e) => kidGuard({ event: e, resolve: ok }) });
			return { res, values };
		};
		const projects = await chain('http://printlab.local/projects', { [SESSION_COOKIE]: token });
		expect(projects.res.status).toBe(303);
		expect(projects.res.headers.get('location')).toBe('/kid');
		expect(projects.values.get(KID_COOKIE)).toBe(kid);

		// The parent PIN (the kid exit route answering 200) releases the session to the household.
		await chain('http://printlab.local/api/kid/exit', { [SESSION_COOKIE]: token }, 'POST');
		expect(service.sessions.find(token)?.row.profileId).toBeNull();
		expect(
			(await chain('http://printlab.local/projects', { [SESSION_COOKIE]: token })).res.status
		).toBe(200);
	});

	it('a grown-up’s PIN session stays theirs through /api/kid/exit (it answers 200 without a PIN too)', async () => {
		await setPassword();
		const dad = t.rt.lab.createProfile({ name: 'Dad', color: 'green' });
		await service.update({ profilePins: true }, HERE);
		await service.setPin(dad, { pin: '2468' }, HERE);
		const { token } = await service.login(
			{ secret: '2468' },
			{ ip: '192.168.1.20', userAgent: '' }
		);
		const { ev } = event('http://printlab.local/api/kid/exit', {
			ip: '192.168.1.20',
			method: 'POST',
			cookies: { [SESSION_COOKIE]: token },
			body: '{"pin":""}',
			headers: { 'content-type': 'application/json', origin: 'http://printlab.local' }
		});
		expect((await auth({ event: ev, resolve: ok })).status).toBe(200);
		expect(service.sessions.find(token)?.row.profileId).toBe(dad);
		expect(service.canManage(ev.locals.auth!)).toBe(false);
	});

	it('the login page is reachable in kid mode', async () => {
		await setPassword();
		t.rt.lab.createProfile({ name: 'Bo', color: 'pink', age: 6, kid: 'little' });
		const bo = t.rt.lab.snapshot().profiles.find((p) => p.name === 'Bo')!;
		const { ev } = event('http://printlab.local/login', {
			ip: '192.168.1.20',
			cookies: { [KID_COOKIE]: bo.id }
		});
		const res = await auth({ event: ev, resolve: (e) => kidGuard({ event: e, resolve: ok }) });
		expect(res.status).toBe(200);
	});
});

describe('CSRF and logging out', () => {
	it('keeps the same-host check for writes, the login form included', async () => {
		await setPassword();
		const { ev } = event('http://printlab.local/login', {
			method: 'POST',
			ip: '192.168.1.20',
			body: 'secret=correct+horse',
			headers: {
				origin: 'https://evil.example',
				'content-type': 'application/x-www-form-urlencoded'
			}
		});
		const res = await crossSiteGuard({
			event: ev,
			resolve: (e) => auth({ event: e, resolve: ok })
		});
		expect(res.status).toBe(403);
	});

	it('logging out ends the session and closes its live stream', async () => {
		await setPassword();
		const { token, row } = service.sessions.create({ profileId: null, userAgent: '', ip: '' });
		const { ev } = event('http://printlab.local/api/events', {
			ip: '192.168.1.20',
			cookies: { [SESSION_COOKIE]: token }
		});
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode('event: hello\n\n'));
			},
			cancel() {
				cancelled = true;
			}
		});
		const res = await auth({
			event: ev,
			resolve: async () =>
				new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
		});
		const reader = res.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: hello\n\n');

		const out = event('http://printlab.local/api/auth/logout', {
			method: 'POST',
			ip: '192.168.1.20',
			cookies: { [SESSION_COOKIE]: token },
			body: '{}',
			headers: { 'content-type': 'application/json' }
		});
		out.ev.locals.auth = { local: false, session: row, ip: '192.168.1.20', userAgent: '' };
		expect((await logoutPost(out.ev)).status).toBe(200);
		expect(out.values.has(SESSION_COOKIE)).toBe(false);
		expect((await reader.read()).done).toBe(true);
		expect(cancelled).toBe(true);
		expect(service.sessions.find(token)).toBeNull();
	});
});

describe('machine endpoints', () => {
	it('let a bearer token through to the routes that check it themselves', async () => {
		await setPassword();
		const bearer = { authorization: 'Bearer plab_abc' };
		const ha = await through('http://printlab.local/api/ha/printers', {
			ip: '192.168.1.30',
			headers: bearer
		});
		expect(ha.res.status).toBe(200);
		const other = await through('http://printlab.local/api/workspace', {
			ip: '192.168.1.30',
			headers: bearer
		});
		expect(other.res.status).toBe(401);
	});
});

describe('renewing the cookie', () => {
	const stale = (token: string) =>
		t.rt.db
			.update(sessions)
			.set({ lastSeenAt: new Date(Date.now() - 60 * 60_000).toISOString() })
			.where(eq(sessions.id, tokenHash(token)))
			.run();

	it('happens only when the scheme is known, so an HTTPS cookie never loses Secure', async () => {
		await setPassword();
		const { token } = service.sessions.create({ profileId: null, userAgent: '', ip: '' });
		const cookies = { [SESSION_COOKIE]: token };
		stale(token);
		// A page load has no Origin: the session slides, the cookie is left alone.
		const page = await through('http://printlab.local/jobs', { ip: '192.168.1.20', cookies });
		expect(page.res.status).toBe(200);
		expect(page.sets).toEqual([]);
		// A write names its origin: renewed, Secure as the browser's scheme says.
		const write = await through('http://printlab.local/api/jobs', {
			ip: '192.168.1.20',
			cookies,
			method: 'POST',
			headers: { origin: 'https://printlab.local' }
		});
		expect(write.sets).toEqual([{ name: SESSION_COOKIE, secure: true }]);
	});
});

describe('kid mode cookies on a LAN name over plain http', () => {
	it('are set and cleared without Secure, so the browser keeps (and drops) them', async () => {
		if (!new ParentPin(t.rt.db).isSet()) t.rt.pin.set({ pin: '9999' });
		const cy = t.rt.lab.createProfile({ name: 'Cy', color: 'pink', age: 7, kid: 'little' });
		const headers = { 'content-type': 'application/json', origin: 'http://printlab.local' };
		const enter = event('https://printlab.local/api/kid/enter', {
			method: 'POST',
			body: JSON.stringify({ profileId: cy }),
			headers
		});
		expect((await kidEnter(enter.ev)).status).toBe(200);
		expect(enter.sets).toEqual([{ name: KID_COOKIE, secure: false }]);
		const exit = event('https://printlab.local/api/kid/exit', {
			method: 'POST',
			body: '{"pin":"9999"}',
			headers,
			cookies: { [KID_COOKIE]: cy }
		});
		expect((await kidExit(exit.ev)).status).toBe(200);
		expect(exit.sets).toEqual([{ name: KID_COOKIE, secure: false }]);
		expect(exit.values.has(KID_COOKIE)).toBe(false);
	});
});

describe('the Secure cookie flag', () => {
	const ev = (url: string, origin?: string) => ({
		url: new URL(url),
		request: new Request(url, { headers: origin ? { origin } : {} })
	});
	it('follows the scheme the browser used, not adapter-node’s https guess', () => {
		expect(isSecure(ev('https://printlab.local/login', 'http://printlab.local'), {})).toBe(false);
		expect(isSecure(ev('https://printlab.local/login', 'https://printlab.local'), {})).toBe(true);
		expect(isSecure(ev('https://printlab.local/'), {})).toBe(false);
		expect(isSecure(ev('https://printlab.local/'), { ORIGIN: 'https://printlab.local' })).toBe(
			true
		);
		expect(isSecure(ev('http://localhost/'), { PROTOCOL_HEADER: 'x-forwarded-proto' })).toBe(false);
	});
});
