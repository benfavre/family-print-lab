// The one way this module reaches the internet. Fetching links people paste is an SSRF risk (the server
// sits on the home network, next to printers and routers), so every request is: https only, to a host
// on the site's allowlist, connected to an address checked here (the checked address is the one used,
// so a second DNS answer cannot swap in a private one), at most 3 redirects (each re-checked), with a
// timeout, a size cap and a content-type check. Nothing here runs unless someone clicks.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { AppError } from '$lib/server/validation';
import { version } from '../../../../../package.json';

export const USER_AGENT = `FamilyPrintLab/${version} (Family Print Lab, home 3D printing app)`;

/** Hosts each kind of request may reach. Sources are cited per site in sites/*.ts. */
export const HOSTS = {
	// The GraphQL API (verified against the live API, 2026-09); images; files (getDownloadLink links).
	printables: ['api.printables.com'],
	printablesMedia: ['media.printables.com'],
	printablesFiles: ['files.printables.com'],
	// REST API with the user's app token; file and image CDN (Thingiverse API schema examples).
	thingiverse: ['api.thingiverse.com'],
	thingiverseCdn: ['cdn.thingiverse.com'],
	// Public model pages; picture CDNs (Bambu Studio src/slic3r/GUI/GUI_App.cpp names public-cdn.bblmw.com;
	// makerworld.bblmw.com is the design picture host in page data).
	makerworld: ['makerworld.com'],
	makerworldMedia: ['makerworld.bblmw.com', 'public-cdn.bblmw.com']
} as const;

export const LIMITS = { html: 2_000_000, json: 2_000_000, image: 5_000_000, model: 100_000_000 };

/** Content types by what is being fetched (model files come with many labels, so those are broad). */
export const TYPES = {
	html: ['text/html'],
	json: ['application/json', 'application/graphql-response+json'],
	image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
	model: [
		'application/octet-stream',
		'binary/octet-stream',
		'application/sla',
		'application/vnd.ms-pki.stl',
		'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
		'application/zip',
		'application/x-zip-compressed',
		'application/x-tgif',
		'model/stl',
		'model/x.stl-binary',
		'model/x.stl-ascii',
		'model/3mf',
		'model/obj',
		'text/plain'
	]
};

/** The 8 groups of an IPv6 address (with an embedded IPv4 tail expanded), or null. */
function ipv6Groups(ip: string): number[] | null {
	let s = ip.toLowerCase().replace(/%.*$/, '');
	const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (v4) {
		const [a, b, c, d] = v4.slice(1).map(Number);
		s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head, tail, extra] = s.split('::');
	if (extra !== undefined) return null;
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const fill = tail === undefined ? 0 : 8 - left.length - right.length;
	if (fill < 0) return null;
	const groups = [...left, ...Array(fill).fill('0'), ...right].map((h) => parseInt(h, 16));
	return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** Loopback, private, link-local, multicast, CGNAT, unspecified and other non-public addresses. */
export function blockedAddress(ip: string): boolean {
	if (net.isIPv4(ip)) {
		const [a, b, c] = ip.split('.').map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) ||
			(a === 192 && b === 88 && c === 99) ||
			(a === 198 && (b === 18 || b === 19)) ||
			(a === 198 && b === 51 && c === 100) ||
			(a === 203 && b === 0 && c === 113) ||
			a >= 224
		);
	}
	const g = net.isIPv6(ip) ? ipv6Groups(ip) : null;
	if (!g) return true;
	const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
	// ::/96 (unspecified, loopback, deprecated IPv4-compatible) is refused; ::ffff:0:0/96 (IPv4-mapped)
	// and ::ffff:0:0:0/96 (IPv4-translated) carry an IPv4 address: judge that one.
	if (g.slice(0, 6).every((x) => x === 0)) return true;
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return blockedAddress(v4(g[6], g[7]));
	if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0)
		return blockedAddress(v4(g[6], g[7]));
	return (
		(g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
		(g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
		(g[0] & 0xffc0) === 0xfec0 || // fec0::/10 old site-local
		(g[0] & 0xff00) === 0xff00 || // ff00::/8 multicast
		(g[0] === 0x64 && g[1] === 0xff9b) || // 64:ff9b::/96 and /48 NAT64
		(g[0] === 0x2001 && g[1] === 0xdb8) || // documentation
		(g[0] === 0x2002 && blockedAddress(v4(g[1], g[2]))) || // 6to4 around a local IPv4
		(g[0] === 0x2001 && g[1] === 0) // Teredo
	);
}

/** Checks a URL before any connection: https, no credentials, default port, host on the list. */
export function checkUrl(input: string | URL, allow: readonly string[]): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new AppError(400, 'That is not a web link.');
	}
	if (url.protocol !== 'https:')
		throw new AppError(400, 'Only secure (https) links can be fetched.');
	if (url.username || url.password) throw new AppError(400, 'Links with a password are refused.');
	if (url.port && url.port !== '443') throw new AppError(400, 'Links to other ports are refused.');
	const host = url.hostname.toLowerCase();
	if (net.isIP(host.replace(/^\[|\]$/g, '')))
		throw new AppError(400, 'Links to an address instead of a site name are refused.');
	if (!allow.includes(host)) throw new AppError(400, `This app does not fetch from ${host}.`);
	return url;
}

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolve: Resolve = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Resolves and returns the first public address; refuses when any answer is not public. */
export async function publicAddress(host: string, resolve: Resolve = systemResolve) {
	let answers: { address: string; family: number }[];
	try {
		answers = await resolve(host);
	} catch {
		throw new AppError(502, `Could not find ${host}. Check the internet connection.`);
	}
	if (!answers.length) throw new AppError(502, `Could not find ${host}.`);
	if (answers.some((a) => blockedAddress(a.address)))
		throw new AppError(400, `${host} points to a local address, so it was refused.`);
	return answers[0];
}

export interface RawResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: AsyncIterable<Buffer>;
	/** Stops reading (the connection is dropped). */
	destroy(): void;
}

/** Sends one request to an already-checked address; tests replace it. */
export type Transport = (
	url: URL,
	address: { address: string; family: number },
	o: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
) => Promise<RawResponse>;

const httpsTransport: Transport = (url, address, o) =>
	new Promise((resolve, reject) => {
		const req = https.request(
			url,
			{
				method: o.method,
				headers: o.headers,
				signal: o.signal,
				// Connect to the address we checked, whatever DNS says now; TLS still verifies the host name.
				lookup: (_host, opts, cb) => {
					if ((opts as { all?: boolean }).all)
						(cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
							address
						]);
					else cb(null, address.address, address.family);
				}
			},
			(res) =>
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: res,
					destroy: () => res.destroy()
				})
		);
		req.on('error', reject);
		req.end(o.body);
	});

export interface FetchOptions {
	/** Hosts this request (and its redirects) may reach. */
	allow: readonly string[];
	kind: keyof typeof LIMITS;
	/** Overrides the kind's size cap. */
	maxBytes?: number;
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	/** Default 15 s, 180 s for model files. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface Fetched {
	url: URL;
	status: number;
	type: string;
	body: Buffer;
}

export interface Fetcher {
	(url: string | URL, o: FetchOptions): Promise<Fetched>;
}

/**
 * Makes the fetch helper. `resolve` and `transport` are for tests; the defaults are the system resolver
 * and node:https.
 */
export function createFetcher(deps: { resolve?: Resolve; transport?: Transport } = {}): Fetcher {
	const transport = deps.transport ?? httpsTransport;
	return async (input, o) => {
		const max = o.maxBytes ?? LIMITS[o.kind];
		const timeout = AbortSignal.timeout(o.timeoutMs ?? (o.kind === 'model' ? 180_000 : 15_000));
		const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
		let url = checkUrl(input, o.allow);
		let method = o.method ?? 'GET';
		let body = o.body;
		let headers = o.headers ?? {};
		try {
			for (let hop = 0; ; hop++) {
				const address = await publicAddress(url.hostname, deps.resolve);
				const res = await transport(url, address, {
					method,
					body,
					signal,
					headers: {
						'user-agent': USER_AGENT,
						accept: TYPES[o.kind].join(', ') + ', */*;q=0.1',
						'accept-encoding': 'identity',
						...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
						...headers
					}
				});
				if (res.status >= 300 && res.status < 400 && res.headers.location) {
					res.destroy();
					if (hop >= 3) throw new AppError(502, 'The site redirected too many times.');
					const next = checkUrl(new URL(res.headers.location, url), o.allow);
					// Credentials (a Thingiverse token) never follow a redirect to another host.
					if (next.hostname !== url.hostname) headers = {};
					if (res.status !== 307 && res.status !== 308) {
						method = 'GET';
						body = undefined;
					}
					url = next;
					continue;
				}
				if (res.status < 200 || res.status >= 300) {
					res.destroy();
					throw new FetchStatusError(res.status, url.hostname);
				}
				const type = String(res.headers['content-type'] ?? '')
					.split(';')[0]
					.trim()
					.toLowerCase();
				if (!TYPES[o.kind].includes(type)) {
					res.destroy();
					throw new AppError(
						502,
						`${url.hostname} sent ${type || 'an unknown type'}, not what was expected.`
					);
				}
				const length = Number(res.headers['content-length'] ?? 0);
				if (length > max) {
					res.destroy();
					throw new AppError(413, `That file is too large (over ${megabytes(max)}).`);
				}
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of res.body) {
					size += chunk.length;
					if (size > max) {
						res.destroy();
						throw new AppError(413, `That file is too large (over ${megabytes(max)}).`);
					}
					chunks.push(chunk);
				}
				return { url, status: res.status, type, body: Buffer.concat(chunks) };
			}
		} catch (error) {
			if (error instanceof AppError) throw error;
			if (timeout.aborted) throw new AppError(504, `${url.hostname} took too long to answer.`);
			if (o.signal?.aborted) throw new AppError(499, 'Stopped.');
			throw new AppError(502, `Could not reach ${url.hostname}: ${(error as Error).message}`);
		}
	};
}

export class FetchStatusError extends AppError {
	constructor(
		readonly upstream: number,
		host: string
	) {
		super(
			502,
			upstream === 404
				? `${host} says that page does not exist.`
				: upstream === 401 || upstream === 403
					? `${host} refused the request (${upstream}).`
					: upstream === 429
						? `${host} asks us to slow down. Try again in a minute.`
						: `${host} answered with an error (${upstream}).`
		);
	}
}

const megabytes = (n: number) => `${Math.round(n / 1_000_000)} MB`;
