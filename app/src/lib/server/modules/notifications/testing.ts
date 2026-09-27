// A local fake HTTP server for the channel tests: records every request and answers with a chosen
// status and body (ntfy, webhooks, Discord and Telegram all look like this from our side).
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
}

export async function fakeServer(
	answer: (r: Received) => { status?: number; body?: unknown } = () => ({})
) {
	const received: Received[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const r = {
				method: req.method ?? '',
				url: req.url ?? '',
				headers: req.headers,
				body: Buffer.concat(chunks)
			};
			received.push(r);
			const { status = 200, body = { ok: true } } = answer(r);
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(typeof body === 'string' ? body : JSON.stringify(body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		received,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}
