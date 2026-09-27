// A fake Spoolman for tests, speaking the routes the client uses (spoolman/api/v1/spool.py).
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export async function fakeSpoolman() {
	const used: { id: number; grams: number; auth?: string }[] = [];
	const spools = [
		{
			id: 7,
			filament: {
				id: 1,
				name: 'Galaxy Black',
				material: 'PLA',
				color_hex: '1a1a2e',
				weight: 1000,
				vendor: { id: 1, name: 'Polymaker' }
			},
			remaining_weight: 640,
			initial_weight: 1000,
			used_weight: 360
		},
		{
			id: 8,
			filament: { id: 2, material: 'PETG', multi_color_hexes: 'ff0000,00ff00', weight: 750 },
			used_weight: 50
		},
		{ id: 9, filament: { id: 3, material: 'ABS' }, used_weight: 0, archived: true }
	];
	const server = http.createServer((req, res) => {
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (req.method === 'GET' && req.url === '/api/v1/info') return send(200, { version: '0.22.1' });
		if (req.method === 'GET' && req.url === '/api/v1/spool') return send(200, spools);
		const use = req.url?.match(/^\/api\/v1\/spool\/(\d+)\/use$/);
		if (req.method === 'PUT' && use) {
			let text = '';
			req.on('data', (c) => (text += c));
			req.on('end', () => {
				const body = JSON.parse(text);
				const spool = spools.find((s) => s.id === Number(use[1]));
				if (!spool) return send(404, { message: 'Spool not found.' });
				used.push({
					id: spool.id,
					grams: body.use_weight,
					auth: req.headers.authorization
				});
				spool.used_weight += body.use_weight;
				if (spool.remaining_weight !== undefined) spool.remaining_weight -= body.use_weight;
				send(200, spool);
			});
			return;
		}
		send(404, { message: 'Not found' });
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	return { url, used, spools, close: () => new Promise((r) => server.close(r)) };
}
