import { describe, expect, it } from 'vitest';
import {
	blockedAddress,
	checkUrl,
	createFetcher,
	publicAddress,
	type RawResponse,
	type Resolve,
	type Transport
} from './fetch';

const PUBLIC: Resolve = async () => [{ address: '93.184.216.34', family: 4 }];

/** A scripted site: answers by URL, records what was asked. */
function fakeSite(
	routes: Record<
		string,
		| { status?: number; type?: string; body?: string | Buffer; location?: string; length?: number }
		| 'hang'
	>
) {
	const calls: { url: string; headers: Record<string, string>; address: string }[] = [];
	const transport: Transport = async (url, address, o) => {
		calls.push({ url: url.href, headers: o.headers, address: address.address });
		const r = routes[url.href];
		if (!r) throw new Error(`unexpected ${url.href}`);
		if (r === 'hang')
			return new Promise<RawResponse>((_, reject) =>
				o.signal.addEventListener('abort', () => reject(new Error('aborted')))
			);
		const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? '');
		let destroyed = false;
		return {
			status: r.status ?? 200,
			headers: {
				'content-type': r.type ?? 'application/json',
				...(r.location ? { location: r.location } : {}),
				...(r.length !== undefined ? { 'content-length': String(r.length) } : {})
			},
			body: (async function* () {
				for (let i = 0; i < body.length && !destroyed; i += 1000) yield body.subarray(i, i + 1000);
			})(),
			destroy: () => (destroyed = true)
		} as RawResponse;
	};
	return { calls, fetch: createFetcher({ resolve: PUBLIC, transport }) };
}

describe('blockedAddress', () => {
	it('refuses loopback, private, link-local, CGNAT, multicast and mapped addresses', () => {
		for (const ip of [
			'127.0.0.1',
			'10.1.2.3',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.20',
			'169.254.169.254',
			'100.64.0.1',
			'0.0.0.0',
			'224.0.0.251',
			'255.255.255.255',
			'::1',
			'::',
			'fe80::1',
			'fd00::1',
			'ff02::1',
			'::ffff:192.168.1.1',
			'::ffff:7f00:1',
			'0:0:0:0:0:ffff:7f00:1',
			'::ffff:0:a00:1',
			'::127.0.0.1',
			'fec0::1',
			'fe80::1%eth0',
			'64:ff9b::7f00:1',
			'2002:c0a8:101::1',
			'2001:0:4136:e378::1',
			'198.51.100.7',
			'not an ip'
		])
			expect(blockedAddress(ip), ip).toBe(true);
	});
	it('allows public addresses', () => {
		for (const ip of [
			'93.184.216.34',
			'172.32.0.1',
			'8.8.8.8',
			'2606:4700::6810:84e5',
			'2606:4700:4700:0:0:0:0:1111',
			'::ffff:8.8.8.8',
			'2002:808:808::1'
		])
			expect(blockedAddress(ip), ip).toBe(false);
	});
});

describe('checkUrl', () => {
	const allow = ['api.printables.com'];
	it('accepts an https link to an allowed host', () => {
		expect(checkUrl('https://api.printables.com/graphql/', allow).hostname).toBe(
			'api.printables.com'
		);
	});
	it('refuses http, other hosts, addresses, passwords and other ports', () => {
		expect(() => checkUrl('http://api.printables.com/', allow)).toThrow(/https/);
		expect(() => checkUrl('https://evil.com/', allow)).toThrow(/does not fetch from evil.com/);
		expect(() => checkUrl('https://api.printables.com.evil.com/', allow)).toThrow(/does not fetch/);
		expect(() => checkUrl('https://127.0.0.1/', ['127.0.0.1'])).toThrow(/address/);
		expect(() => checkUrl('https://[::1]/', ['[::1]', '::1'])).toThrow(/address/);
		expect(() => checkUrl('https://u:p@api.printables.com/', allow)).toThrow(/password/);
		expect(() => checkUrl('https://api.printables.com:8443/', allow)).toThrow(/ports/);
		expect(() => checkUrl('file:///etc/passwd', allow)).toThrow(/https/);
		expect(() => checkUrl('nonsense', allow)).toThrow(/not a web link/);
	});
});

describe('publicAddress', () => {
	it('refuses a name that resolves to a local address, even among public ones', async () => {
		await expect(
			publicAddress('api.printables.com', async () => [{ address: '127.0.0.1', family: 4 }])
		).rejects.toThrow(/local address/);
		await expect(
			publicAddress('api.printables.com', async () => [
				{ address: '93.184.216.34', family: 4 },
				{ address: '192.168.1.1', family: 4 }
			])
		).rejects.toThrow(/local address/);
		await expect(
			publicAddress('x', async () => {
				throw new Error('ENOTFOUND');
			})
		).rejects.toThrow(/Could not find/);
		expect((await publicAddress('x', PUBLIC)).address).toBe('93.184.216.34');
	});

	it('never connects when DNS points home (real https transport)', async () => {
		const fetch = createFetcher({ resolve: async () => [{ address: '10.0.0.1', family: 4 }] });
		await expect(
			fetch('https://api.printables.com/graphql/', { allow: ['api.printables.com'], kind: 'json' })
		).rejects.toThrow(/local address/);
	});
});

describe('createFetcher', () => {
	const A = 'https://api.thingiverse.com/files/1/download';
	const CDN = 'https://cdn.thingiverse.com/assets/a.stl';
	const allow = ['api.thingiverse.com', 'cdn.thingiverse.com'];

	it('follows redirects to allowed hosts and drops credentials on the way', async () => {
		const site = fakeSite({
			[A]: { status: 302, location: CDN },
			[CDN]: { type: 'application/sla', body: 'solid x' }
		});
		const res = await site.fetch(A, {
			allow,
			kind: 'model',
			headers: { authorization: 'Bearer secret' }
		});
		expect(res.body.toString()).toBe('solid x');
		expect(site.calls[0].headers.authorization).toBe('Bearer secret');
		expect(site.calls[1].headers.authorization).toBeUndefined();
		expect(site.calls[0].headers['user-agent']).toMatch(/^FamilyPrintLab\//);
		expect(site.calls[1].address).toBe('93.184.216.34');
	});

	it('refuses a redirect to another host, to http or to an address', async () => {
		for (const location of [
			'https://evil.com/x',
			'http://cdn.thingiverse.com/a.stl',
			'https://169.254.169.254/latest'
		]) {
			const site = fakeSite({ [A]: { status: 301, location } });
			await expect(site.fetch(A, { allow, kind: 'model' })).rejects.toThrow(
				/does not fetch|https|address/
			);
			expect(site.calls).toHaveLength(1);
		}
	});

	it('stops after 3 redirects', async () => {
		const u = (n: number) => `https://api.thingiverse.com/r${n}`;
		const site = fakeSite({
			[u(0)]: { status: 302, location: u(1) },
			[u(1)]: { status: 302, location: u(2) },
			[u(2)]: { status: 302, location: u(3) },
			[u(3)]: { status: 302, location: u(4) },
			[u(4)]: { body: '{}' }
		});
		await expect(site.fetch(u(0), { allow, kind: 'json' })).rejects.toThrow(/too many/);
		expect(site.calls).toHaveLength(4);
		const ok = fakeSite({
			[u(0)]: { status: 302, location: u(1) },
			[u(1)]: { status: 302, location: u(2) },
			[u(2)]: { status: 302, location: u(3) },
			[u(3)]: { body: '{}' }
		});
		expect((await ok.fetch(u(0), { allow, kind: 'json' })).body.toString()).toBe('{}');
	});

	it('refuses files over the cap, by header or while reading', async () => {
		const big = fakeSite({ [CDN]: { type: 'image/jpeg', length: 6_000_000 } });
		await expect(big.fetch(CDN, { allow, kind: 'image' })).rejects.toThrow(
			/too large \(over 5 MB\)/
		);
		const sneaky = fakeSite({ [CDN]: { type: 'text/html', body: Buffer.alloc(2_000_001) } });
		await expect(sneaky.fetch(CDN, { allow, kind: 'html' })).rejects.toThrow(/over 2 MB/);
		const model = fakeSite({ [CDN]: { type: 'model/stl', body: Buffer.alloc(5000) } });
		await expect(model.fetch(CDN, { allow, kind: 'model', maxBytes: 4000 })).rejects.toThrow(
			/too large/
		);
	});

	it('checks the content type', async () => {
		const site = fakeSite({ [CDN]: { type: 'text/html', body: '<html>' } });
		await expect(site.fetch(CDN, { allow, kind: 'image' })).rejects.toThrow(/sent text\/html/);
		await expect(site.fetch(CDN, { allow, kind: 'json' })).rejects.toThrow(/sent text\/html/);
	});

	it('reports error statuses in plain words', async () => {
		const site = fakeSite({
			[A]: { status: 404 },
			[CDN]: { status: 429 }
		});
		await expect(site.fetch(A, { allow, kind: 'json' })).rejects.toThrow(/does not exist/);
		await expect(site.fetch(CDN, { allow, kind: 'json' })).rejects.toThrow(/slow down/);
	});

	it('gives up after the timeout', async () => {
		const site = fakeSite({ [A]: 'hang' });
		await expect(site.fetch(A, { allow, kind: 'json', timeoutMs: 50 })).rejects.toThrow(
			/took too long/
		);
	});
});
