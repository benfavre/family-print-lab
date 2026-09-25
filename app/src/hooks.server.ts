import { gzipSync } from 'node:zlib';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { runtime } from '$lib/server/runtime';

export const init: ServerInit = () => {
	runtime();
};

// The app is meant for this computer (or a trusted LAN when HOST is set). Reject other Host headers so a
// malicious web page cannot reach it through DNS rebinding, and reject cross-site writes.
const allowedHosts = new Set([
	'localhost',
	'127.0.0.1',
	'[::1]',
	...(env.ALLOWED_HOSTS ?? '')
		.split(',')
		.map((h) => h.trim())
		.filter(Boolean)
]);

// Same-origin check by host: the Origin a browser sends must name the host it is talking to.
// (Comparing full origins is unreliable behind adapter-node, which cannot always know the protocol.)
function sameHost(origin: string | null, host: string | null) {
	if (!origin) return true;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	const { request, url } = event;
	if (!allowedHosts.has(url.hostname)) return new Response('Local access only.', { status: 403 });
	const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
	if (isWrite && !sameHost(request.headers.get('origin'), request.headers.get('host'))) {
		return new Response(JSON.stringify({ error: 'Cross-site request blocked.' }), {
			status: 403,
			headers: { 'content-type': 'application/json' }
		});
	}
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	// API data must not be cached, except files that say otherwise (versioned meshes, thumbnails, sketches).
	if (url.pathname.startsWith('/api/') && !response.headers.has('Cache-Control'))
		response.headers.set('Cache-Control', 'no-store');
	return compressJson(request, response);
};

/**
 * JSON from the API (the workspace is sent with every write and refresh) goes out gzipped: about
 * 7× smaller. The node adapter only compresses static files by itself.
 */
async function compressJson(request: Request, response: Response): Promise<Response> {
	if (
		!(response.headers.get('content-type') ?? '').startsWith('application/json') ||
		response.headers.has('content-encoding') ||
		!/\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')
	)
		return response;
	const body = Buffer.from(await response.arrayBuffer());
	if (body.length < 4096) return new Response(body, response);
	const headers = new Headers(response.headers);
	headers.set('content-encoding', 'gzip');
	headers.append('vary', 'Accept-Encoding');
	headers.delete('content-length');
	return new Response(gzipSync(body, { level: 5 }), { status: response.status, headers });
}
