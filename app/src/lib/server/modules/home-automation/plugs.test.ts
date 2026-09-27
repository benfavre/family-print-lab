// Each plug client against the simulator's fake plug (which answers the way each device's docs say),
// with and without logins, and the failures people will meet.
import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakePlug, type FakePlugServer } from '../../printer/sim/features/power';
import { digestHeader, plugClient, PlugError } from './plugs';

const servers: (FakePlugServer | http.Server)[] = [];
afterEach(async () => {
	for (const s of servers.splice(0))
		await ('requests' in s ? s.close() : new Promise((r) => s.close(() => r(null))));
});

async function fake(o: Omit<Parameters<typeof createFakePlug>[0], 'plug'> = {}) {
	const plug = {
		on: false,
		set(on: boolean) {
			plug.on = on;
		}
	};
	const server = await createFakePlug({ plug, ...o });
	servers.push(server);
	return { plug, server, url: `http://127.0.0.1:${server.port}` };
}

describe('plug clients', () => {
	it('Tasmota: Power On / Off / Power, with the login as query parameters', async () => {
		const { plug, server, url } = await fake({ user: 'admin', password: 'p w' });
		const c = plugClient('tasmota', { url, user: 'admin', password: 'p w' });
		await c.set(true);
		expect(plug.on).toBe(true);
		expect(await c.read()).toBe(true);
		await c.set(false);
		expect(await c.read()).toBe(false);
		expect(server.requests[0]).toBe('GET /cm?user=admin&password=p%20w&cmnd=Power%20On');
		await expect(plugClient('tasmota', { url, password: 'nope' }).set(true)).rejects.toThrow(
			/refused the login/
		);
	});

	it('Shelly Gen1: /relay/0?turn=on with Basic auth, ison read back', async () => {
		const { plug, server, url } = await fake({ user: 'me', password: 'secret' });
		const c = plugClient('shelly', { url: `${url}/`, user: 'me', password: 'secret', channel: 0 });
		await c.set(true);
		expect(plug.on).toBe(true);
		expect(await c.read()).toBe(true);
		expect(server.requests).toEqual(['GET /relay/0?turn=on', 'GET /relay/0']);
		await expect(plugClient('shelly', { url }).read()).rejects.toThrow(/refused the login/);
	});

	it('Shelly Gen2+: Switch.Set / Switch.GetStatus, answering the SHA-256 digest challenge', async () => {
		const { plug, server, url } = await fake({ password: 'pw', digest: true });
		const c = plugClient('shelly-rpc', { url, password: 'pw' });
		await c.set(true);
		expect(plug.on).toBe(true);
		expect(await c.read()).toBe(true);
		// Each call: the challenge, then the answer.
		expect(server.requests.slice(0, 2)).toEqual([
			'GET /rpc/Switch.Set?id=0&on=true',
			'GET /rpc/Switch.Set?id=0&on=true'
		]);
		await expect(plugClient('shelly-rpc', { url, password: 'wrong' }).read()).rejects.toThrow(
			/refused the login/
		);
		// No password saved: the challenge is answered with an error in plain words.
		await expect(plugClient('shelly-rpc', { url }).read()).rejects.toThrow(/refused the login/);
	});

	it('Home Assistant: POST /api/services/switch/turn_on with the token, state read back', async () => {
		const { plug, server, url } = await fake({ token: 'tok', entityId: 'switch.printer' });
		const c = plugClient('homeassistant', { url, token: 'tok', entityId: 'switch.printer' });
		await c.set(true);
		expect(plug.on).toBe(true);
		expect(await c.read()).toBe(true);
		expect(server.requests).toEqual([
			'POST /api/services/switch/turn_on',
			'GET /api/states/switch.printer'
		]);
		// Other on/off entities go through the generic homeassistant services.
		await plugClient('homeassistant', { url, token: 'tok', entityId: 'light.printer' })
			.set(false)
			.catch(() => {});
		expect(server.requests.at(-1)).toBe('POST /api/services/homeassistant/turn_off');
		await expect(
			plugClient('homeassistant', { url, token: 'bad', entityId: 'switch.printer' }).read()
		).rejects.toThrow(/refused the login/);
		await expect(
			plugClient('homeassistant', { url, token: 'tok', entityId: 'switch.other' }).read()
		).rejects.toThrow(/no entity switch.other/);
		await expect(
			plugClient('homeassistant', { url, entityId: 'switch.printer' }).read()
		).rejects.toThrow(/long-lived access token/);
	});

	it('webhooks: POST the on or off address, and cannot be read', async () => {
		const { plug, server, url } = await fake();
		const c = plugClient('webhook', { onUrl: `${url}/on`, offUrl: `${url}/off` });
		await c.set(true);
		expect(plug.on).toBe(true);
		await c.set(false);
		expect(plug.on).toBe(false);
		expect(await c.read()).toBeNull();
		expect(server.requests).toEqual(['POST /on', 'POST /off']);
		await plugClient('webhook', { onUrl: `${url}/on`, offUrl: `${url}/off`, method: 'GET' }).set(
			true
		);
		expect(server.requests.at(-1)).toBe('GET /on');
	});

	it('says plainly when a plug is not there, too slow, or answers nonsense', async () => {
		// A port nothing listens on.
		const closed = http.createServer();
		await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
		const port = (closed.address() as net.AddressInfo).port;
		await new Promise((r) => closed.close(r));
		await expect(plugClient('tasmota', { url: `http://127.0.0.1:${port}` }).read()).rejects.toThrow(
			/refused the connection/
		);
		const odd = http.createServer((_, res) => res.end('<html>'));
		servers.push(odd);
		await new Promise<void>((r) => odd.listen(0, '127.0.0.1', () => r()));
		const url = `http://127.0.0.1:${(odd.address() as net.AddressInfo).port}`;
		await expect(plugClient('shelly', { url }).read()).rejects.toThrow(/does not understand/);
		await expect(plugClient('tasmota', {}).read()).rejects.toBeInstanceOf(PlugError);
		const stop = new AbortController();
		stop.abort();
		await expect(plugClient('shelly', { url }).read(stop.signal)).rejects.toThrow('Stopped');
	});
});

describe('digest login', () => {
	it('computes RFC 7616 answers (SHA-256 with qop=auth, MD5 without)', () => {
		const url = new URL('http://plug/rpc/Switch.Set?id=0&on=true');
		const sha = digestHeader(
			'Digest qop="auth", realm="shellyplus1-abc", nonce="bm9uY2U=", algorithm=SHA-256',
			'GET',
			url,
			'admin',
			'pw',
			'0a1b2c3d'
		)!;
		expect(sha).toContain('username="admin"');
		expect(sha).toContain('uri="/rpc/Switch.Set?id=0&on=true"');
		expect(sha).toContain('qop=auth, nc=00000001, cnonce="0a1b2c3d"');
		// RFC 2617 3.5 example: Mufasa / "Circle Of Life" at /dir/index.html.
		const md5 = digestHeader(
			'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
			'GET',
			new URL('http://host/dir/index.html'),
			'Mufasa',
			'Circle Of Life',
			'0a4f113b'
		)!;
		expect(md5).toContain('response="6629fae49393a05397450978507c4ef1"');
		expect(md5).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
		expect(digestHeader('Basic realm="x"', 'GET', url, 'a', 'b')).toBeNull();
	});
});
