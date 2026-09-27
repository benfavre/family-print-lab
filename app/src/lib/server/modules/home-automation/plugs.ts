// Smart plug clients: switch a relay on or off and read it back, over each device's own local HTTP
// API. Every request has a 5 s time limit and honours the caller's AbortSignal.
import crypto from 'node:crypto';
import type { PlugKind } from '$lib/shared/home-automation';
import type { PlugConfig } from './validation';

export interface PlugClient {
	set(on: boolean, signal?: AbortSignal): Promise<void>;
	/** The relay state, or null when this kind cannot be read back (webhooks). */
	read(signal?: AbortSignal): Promise<boolean | null>;
}

export class PlugError extends Error {}

const TIMEOUT_MS = 5000;
const base = (url: string | undefined) => {
	if (!url) throw new PlugError('The plug has no address yet.');
	return url.replace(/\/+$/, '');
};

async function request(
	url: string,
	init: RequestInit & { signal?: AbortSignal },
	what: string
): Promise<Response> {
	const signal = init.signal
		? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
		: AbortSignal.timeout(TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal, redirect: 'manual' });
	} catch (error) {
		if (init.signal?.aborted) throw new PlugError('Stopped');
		const e = error as Error & { cause?: { code?: string } };
		if (e.name === 'TimeoutError') throw new PlugError(`${what} did not answer within 5 seconds.`);
		if (e.cause?.code === 'ECONNREFUSED') throw new PlugError(`${what} refused the connection.`);
		throw new PlugError(`Could not reach ${what.toLowerCase()} (${e.cause?.code ?? e.message}).`);
	}
}

async function expectOk(res: Response, what: string) {
	if (res.status === 401 || res.status === 403)
		throw new PlugError(`${what} refused the login. Check the user name and password.`);
	if (!res.ok) throw new PlugError(`${what} answered with an error (HTTP ${res.status}).`);
}

async function jsonOf(res: Response, what: string): Promise<Record<string, unknown>> {
	await expectOk(res, what);
	try {
		return (await res.json()) as Record<string, unknown>;
	} catch {
		throw new PlugError(`${what} sent an answer the app does not understand.`);
	}
}

const basic = (user: string | undefined, password: string | undefined): HeadersInit =>
	user || password
		? {
				authorization: `Basic ${Buffer.from(`${user ?? ''}:${password ?? ''}`).toString('base64')}`
			}
		: {};

/**
 * Tasmota: `GET http://<ip>/cm?cmnd=Power%20On` (or Off, or plain Power to read), with `user` and
 * `password` query parameters when a web password is set; answers {"POWER":"ON"} (or POWER1 on
 * multi-relay devices). https://tasmota.github.io/docs/Commands/#with-web-requests
 */
export function tasmota(c: PlugConfig): PlugClient {
	const what = 'The Tasmota plug';
	const call = async (cmnd: string, signal?: AbortSignal) => {
		const q = new URLSearchParams();
		if (c.user || c.password) {
			q.set('user', c.user || 'admin');
			q.set('password', c.password ?? '');
		}
		q.set('cmnd', cmnd);
		// URLSearchParams writes spaces as +; Tasmota's examples use %20.
		const url = `${base(c.url)}/cm?${q.toString().replace(/\+/g, '%20')}`;
		const body = await jsonOf(await request(url, { signal }, what), what);
		if (body.WARNING) throw new PlugError(`${what}: ${String(body.WARNING)}`);
		const state = body.POWER ?? body.POWER1;
		if (state !== 'ON' && state !== 'OFF') throw new PlugError(`${what} did not say its state.`);
		return state === 'ON';
	};
	return {
		async set(on, signal) {
			await call(`Power ${on ? 'On' : 'Off'}`, signal);
		},
		read: (signal) => call('Power', signal)
	};
}

/**
 * First-generation Shelly: `GET /relay/<n>?turn=on|off`, `GET /relay/<n>` answers {"ison": true};
 * HTTP Basic auth when a login is set. https://shelly-api-docs.shelly.cloud/gen1/#shelly1-shelly1pm-relay-index
 */
export function shellyGen1(c: PlugConfig): PlugClient {
	const what = 'The Shelly plug';
	const call = async (query: string, signal?: AbortSignal) => {
		const url = `${base(c.url)}/relay/${c.channel ?? 0}${query}`;
		const body = await jsonOf(
			await request(url, { signal, headers: basic(c.user, c.password) }, what),
			what
		);
		if (typeof body.ison !== 'boolean') throw new PlugError(`${what} did not say its state.`);
		return body.ison;
	};
	return {
		async set(on, signal) {
			await call(`?turn=${on ? 'on' : 'off'}`, signal);
		},
		read: (signal) => call('', signal)
	};
}

/**
 * Shelly Plus/Pro and newer (Gen2+ RPC): `GET /rpc/Switch.Set?id=<n>&on=true|false`,
 * `GET /rpc/Switch.GetStatus?id=<n>` answers {"output": true}.
 * https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch
 * With a password set, the device answers 401 with a SHA-256 digest challenge; user is always "admin".
 * https://shelly-api-docs.shelly.cloud/gen2/General/Authentication
 */
export function shellyRpc(c: PlugConfig): PlugClient {
	const what = 'The Shelly plug';
	const call = async (path: string, signal?: AbortSignal) => {
		const url = `${base(c.url)}${path}`;
		let res = await request(url, { signal }, what);
		if (res.status === 401 && c.password) {
			const challenge = res.headers.get('www-authenticate') ?? '';
			await res.body?.cancel();
			const authorization = digestHeader(challenge, 'GET', new URL(url), 'admin', c.password);
			if (!authorization) throw new PlugError(`${what} asked for a login the app does not know.`);
			res = await request(url, { signal, headers: { authorization } }, what);
		}
		return jsonOf(res, what);
	};
	const id = c.channel ?? 0;
	return {
		async set(on, signal) {
			await call(`/rpc/Switch.Set?id=${id}&on=${on}`, signal);
		},
		async read(signal) {
			const body = await call(`/rpc/Switch.GetStatus?id=${id}`, signal);
			if (typeof body.output !== 'boolean') throw new PlugError(`${what} did not say its state.`);
			return body.output;
		}
	};
}

/**
 * The Authorization header answering a Digest challenge (RFC 7616, qop=auth; SHA-256 as Shelly Gen2+
 * uses, MD5 for older servers). `uri` is the request-URI (path and query), as RFC 7616 3.4 says.
 */
export function digestHeader(
	challenge: string,
	method: string,
	url: URL,
	user: string,
	password: string,
	cnonce = crypto.randomBytes(8).toString('hex')
): string | null {
	if (!/^\s*digest\s/i.test(challenge)) return null;
	const params: Record<string, string> = {};
	for (const m of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g))
		params[m[1].toLowerCase()] = m[2] ?? m[3];
	const { realm, nonce, opaque } = params;
	if (realm === undefined || !nonce) return null;
	const algorithm = (params.algorithm ?? 'MD5').toUpperCase();
	const hashName = algorithm === 'SHA-256' ? 'sha256' : algorithm === 'MD5' ? 'md5' : null;
	if (!hashName) return null;
	const h = (s: string) => crypto.createHash(hashName).update(s).digest('hex');
	const uri = url.pathname + url.search;
	const nc = '00000001';
	const ha1 = h(`${user}:${realm}:${password}`);
	const ha2 = h(`${method}:${uri}`);
	const qop = params.qop?.split(',').map((q) => q.trim());
	const response = qop?.includes('auth')
		? h(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
		: h(`${ha1}:${nonce}:${ha2}`);
	return [
		`Digest username="${user}"`,
		`realm="${realm}"`,
		`nonce="${nonce}"`,
		`uri="${uri}"`,
		`algorithm=${algorithm}`,
		`response="${response}"`,
		...(qop?.includes('auth') ? ['qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`] : []),
		...(opaque ? [`opaque="${opaque}"`] : [])
	].join(', ');
}

/**
 * Home Assistant REST: `POST /api/services/<domain>/turn_on|turn_off` with a long-lived token and
 * {"entity_id"}; `GET /api/states/<entity_id>` answers {"state": "on"}.
 * https://developers.home-assistant.io/docs/api/rest/
 * switch.* entities use the switch domain; others (light, input_boolean…) the generic homeassistant
 * services, which turn any on/off entity on or off (https://www.home-assistant.io/docs/scripts/perform-actions/).
 */
export function homeAssistant(c: PlugConfig): PlugClient {
	const what = 'Home Assistant';
	const headers = () => {
		if (!c.token) throw new PlugError('Home Assistant needs a long-lived access token.');
		return { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' };
	};
	const entity = () => {
		if (!c.entityId) throw new PlugError('Choose the Home Assistant entity of the plug.');
		return c.entityId;
	};
	return {
		async set(on, signal) {
			const id = entity();
			const domain = id.startsWith('switch.') ? 'switch' : 'homeassistant';
			const res = await request(
				`${base(c.url)}/api/services/${domain}/turn_${on ? 'on' : 'off'}`,
				{ method: 'POST', headers: headers(), body: JSON.stringify({ entity_id: id }), signal },
				what
			);
			await expectOk(res, what);
			await res.body?.cancel();
		},
		async read(signal) {
			const res = await request(
				`${base(c.url)}/api/states/${encodeURIComponent(entity())}`,
				{ headers: headers(), signal },
				what
			);
			if (res.status === 404) throw new PlugError(`Home Assistant has no entity ${c.entityId}.`);
			const body = await jsonOf(res, what);
			if (body.state === 'on') return true;
			if (body.state === 'off') return false;
			throw new PlugError(`Home Assistant says the plug is ${String(body.state ?? 'unknown')}.`);
		}
	};
}

/** Any other plug or automation: one address to switch on, one to switch off (GET or POST). */
export function webhook(c: PlugConfig): PlugClient {
	const what = 'The web address';
	return {
		async set(on, signal) {
			const url = on ? c.onUrl : c.offUrl;
			if (!url) throw new PlugError(`Add the address that switches the plug ${on ? 'on' : 'off'}.`);
			const method = c.method ?? 'POST';
			const res = await request(
				url,
				{
					method,
					signal,
					...(method === 'POST' && {
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ power: on ? 'on' : 'off' })
					})
				},
				what
			);
			await expectOk(res, what);
			await res.body?.cancel();
		},
		read: async () => null
	};
}

export function plugClient(kind: PlugKind, config: PlugConfig): PlugClient {
	switch (kind) {
		case 'tasmota':
			return tasmota(config);
		case 'shelly':
			return shellyGen1(config);
		case 'shelly-rpc':
			return shellyRpc(config);
		case 'homeassistant':
			return homeAssistant(config);
		case 'webhook':
			return webhook(config);
	}
}
