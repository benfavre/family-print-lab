// A stand-in for Print Lab Cloud that speaks docs/cloud-protocol.md, for tests and development.
// It links any pairing someone "approves" through its control API, keeps what the app reports, and
// can send `decide` commands as if a grown-up answered on the phone. No dependencies: it includes a
// minimal WebSocket server (text frames, ping/pong, close).
//
//   npx tsx tools/cloud-sim.ts --port 18881
//   POST /sim/link {code, account?}        link a pending pairing
//   GET  /sim/state                         devices, reported requests, connection
//   POST /sim/decide {requestId, decision, reply?, version?}   answer as the phone would
//   POST /sim/plan {active}                 Family plan on or off (sent on next connect)
//   POST /sim/unlink                        remove the device (tells a connected app)
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';

interface Pairing {
	pairingId: string;
	userCode: string;
	name: string;
	account: string | null;
}
interface Device {
	id: string;
	token: string;
	name: string;
	account: string;
}
interface Socket {
	send(text: string): void;
	close(code: number, reason: string): void;
}
export interface Summary {
	id: string;
	version: number;
	status: string;
	[key: string]: unknown;
}

export interface CloudSim {
	url: string;
	link(code: string, account?: string): boolean;
	decide(
		requestId: string,
		decision: 'approve' | 'decline',
		reply?: string,
		version?: number
	): Promise<{ ok: boolean; error?: string }>;
	setPlan(active: boolean): void;
	/** Template packs served to Family plan accounts. */
	setPacks(packs: unknown[]): void;
	/** The shop: items (with what to install), the account's credits, and files for models. */
	setShop(shop: { items: SimShopItem[]; credits: number; files?: Record<string, Buffer> }): void;
	unlink(): void;
	state(): {
		devices: { id: string; name: string; account: string }[];
		connected: boolean;
		hello: { app?: string; protocol?: number } | null;
		requests: Summary[];
		/** The last `printer` message: undefined if none came, null if sharing is off. */
		printer: unknown;
		printerMessages: number;
		backups: { id: string; size: number; keyId: string }[];
	};
	close(): Promise<void>;
}

export interface SimShopItem {
	id: string;
	kind: 'kid-pack' | 'part' | 'model';
	title: string;
	price: number;
	/** What /device/library adds: { pack }, { name, source } or { file, format }. */
	content: Record<string, unknown>;
}

const token = () => randomBytes(24).toString('base64url');
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const userCode = () => {
	const c = [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
	return `${c.slice(0, 4)}-${c.slice(4)}`;
};

export function startCloudSim(port = 0, host = '127.0.0.1'): Promise<CloudSim> {
	const pairings: Pairing[] = [];
	const devices: Device[] = [];
	const tickets = new Map<string, string>();
	let socket: Socket | null = null;
	let hello: { app?: string; protocol?: number } | null = null;
	let requests: Summary[] = [];
	let printer: unknown = undefined;
	const backups: {
		id: string;
		account: string;
		device: string;
		keyId: string;
		data: Buffer;
		createdAt: string;
	}[] = [];
	let printerMessages = 0;
	let packs: unknown[] = [];
	let shop: { items: SimShopItem[]; credits: number; files?: Record<string, Buffer> } = {
		items: [],
		credits: 0
	};
	const owned = new Set<string>();
	let plan = true;
	const waiting = new Map<string, (r: { ok: boolean; error?: string }) => void>();
	let url = '';

	const json = (res: http.ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	};
	const readBody = (req: http.IncomingMessage) =>
		new Promise<Record<string, unknown>>((resolve) => {
			let data = '';
			req.on('data', (c) => (data += c));
			req.on('end', () => {
				try {
					resolve(data ? JSON.parse(data) : {});
				} catch {
					resolve({});
				}
			});
		});
	const bearer = (req: http.IncomingMessage) =>
		devices.find((d) => req.headers.authorization === `Bearer ${d.token}`);

	const api: CloudSim = {
		get url() {
			return url;
		},
		link(code, account = 'parent@example.com') {
			const p = pairings.find((x) => x.userCode === code && !x.account);
			if (!p) return false;
			p.account = account;
			return true;
		},
		decide(requestId, decision, reply = '', version) {
			if (!socket) return Promise.resolve({ ok: false, error: 'offline' });
			const r = requests.find((x) => x.id === requestId);
			const commandId = token();
			const result = new Promise<{ ok: boolean; error?: string }>((resolve) =>
				waiting.set(commandId, resolve)
			);
			socket.send(
				JSON.stringify({
					type: 'decide',
					commandId,
					requestId,
					version: version ?? r?.version ?? 1,
					decision,
					reply,
					by: devices[0]?.account ?? 'parent@example.com'
				})
			);
			return result;
		},
		setPacks(next) {
			packs = next;
		},
		setShop(next) {
			shop = next;
		},
		setPlan(active) {
			plan = active;
			socket?.send(JSON.stringify({ type: 'plan', plan }));
		},
		unlink() {
			devices.length = 0;
			socket?.send(JSON.stringify({ type: 'unlinked' }));
			socket?.close(4401, 'Unlinked.');
		},
		state: () => ({
			devices: devices.map(({ id, name, account }) => ({ id, name, account })),
			connected: !!socket,
			hello,
			requests,
			printer,
			printerMessages,
			backups: backups.map((b) => ({ id: b.id, size: b.data.length, keyId: b.keyId }))
		}),
		close: () =>
			new Promise((resolve) => {
				socket?.close(1001, 'Going away.');
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};

	const server = http.createServer(async (req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		if (path.startsWith('/device/shop') || path.startsWith('/device/library')) {
			if (!bearer(req)) return json(res, 401, { error: 'This device is not linked.' });
			const pub = (i: SimShopItem) => ({
				id: i.id,
				kind: i.kind,
				kindLabel: i.kind,
				title: i.title,
				blurb: 'blurb',
				description: 'description',
				price: i.price,
				plan: false,
				facts: [],
				version: 1
			});
			if (path === '/device/shop')
				return json(res, 200, {
					items: shop.items.map((i) => ({ ...pub(i), owned: owned.has(i.id) })),
					balance: shop.credits,
					plan,
					site: url
				});
			const buying = /^\/device\/shop\/([\w-]+)\/buy$/.exec(path);
			if (buying && req.method === 'POST') {
				const item = shop.items.find((i) => i.id === buying[1]);
				if (!item) return json(res, 404, { error: 'Not in the shop.' });
				if (owned.has(item.id)) return json(res, 409, { error: 'You already have this one.' });
				if (shop.credits < item.price)
					return json(res, 402, {
						error: `You need ${item.price - shop.credits} more credits for this.`
					});
				shop.credits -= item.price;
				owned.add(item.id);
				socket?.send(JSON.stringify({ type: 'library' }));
				return json(res, 200, { balance: shop.credits });
			}
			if (path === '/device/library')
				return json(res, 200, {
					items: shop.items.filter((i) => owned.has(i.id)).map((i) => ({ ...pub(i), ...i.content }))
				});
			const file = /^\/device\/library\/([\w-]+)\/file$/.exec(path);
			const data = file && owned.has(file[1]) ? shop.files?.[file[1]] : undefined;
			if (!data) return json(res, 404, { error: 'You do not have this one.' });
			res.writeHead(200, { 'content-type': 'application/octet-stream' });
			return res.end(data);
		}
		if (path === '/device/packs') {
			if (!bearer(req)) return json(res, 401, { error: 'This device is not linked.' });
			return json(res, 200, { plan, packs: plan ? packs : [] });
		}
		// Encrypted backups: stored as sent (the simulator, like the cloud, cannot open them).
		if (path === '/device/backups' || path.startsWith('/device/backups/')) {
			const d = bearer(req);
			if (!d) return json(res, 401, { error: 'This device is not linked.' });
			if (req.method === 'PUT') {
				if (!plan) return json(res, 402, { error: 'Cloud backup is part of the Family plan.' });
				const chunks: Buffer[] = [];
				for await (const c of req) chunks.push(c as Buffer);
				const id = `${Date.now()}-${backups.length}_${d.id}.plb`;
				backups.unshift({
					id,
					account: d.account,
					device: d.name,
					keyId: String(req.headers['x-backup-key'] ?? ''),
					data: Buffer.concat(chunks),
					createdAt: new Date().toISOString()
				});
				return json(res, 200, { ok: true, id });
			}
			const mine = backups.filter((b) => b.account === d.account);
			if (path === '/device/backups')
				return json(res, 200, {
					backups: mine.map((b) => ({
						id: b.id,
						device: b.device,
						createdAt: b.createdAt,
						size: b.data.length,
						keyId: b.keyId
					}))
				});
			const found = mine.find((b) => b.id === decodeURIComponent(path.slice(16)));
			if (!found) return json(res, 404, { error: 'Not found.' });
			res.writeHead(200, { 'content-type': 'application/octet-stream' });
			return res.end(found.data);
		}
		const body = req.method === 'POST' ? await readBody(req) : {};
		if (path === '/device/pair') {
			const p: Pairing = {
				pairingId: token(),
				userCode: userCode(),
				name: String(body.name ?? 'Family Print Lab'),
				account: null
			};
			pairings.push(p);
			return json(res, 200, {
				pairingId: p.pairingId,
				userCode: p.userCode,
				verifyUrl: `${url}/link`,
				expiresIn: 600,
				interval: 0.1
			});
		}
		if (path === '/device/pair/poll') {
			const i = pairings.findIndex((p) => p.pairingId === body.pairingId);
			if (i < 0) return json(res, 200, { status: 'expired' });
			const p = pairings[i];
			if (!p.account) return json(res, 200, { status: 'pending' });
			pairings.splice(i, 1);
			const d: Device = { id: token(), token: token(), name: p.name, account: p.account };
			devices.push(d);
			return json(res, 200, {
				status: 'linked',
				deviceToken: d.token,
				deviceId: d.id,
				account: d.account
			});
		}
		if (path === '/device/session') {
			const d = bearer(req);
			if (!d) return json(res, 401, { error: 'This device is not linked.' });
			const t = token();
			tickets.set(t, d.id);
			return json(res, 200, { ticket: t });
		}
		if (path === '/device/unlink') {
			const d = bearer(req);
			if (d) devices.splice(devices.indexOf(d), 1);
			return json(res, 200, { ok: true });
		}
		if (path === '/sim/link')
			return json(
				res,
				api.link(String(body.code), body.account as string | undefined) ? 200 : 404,
				{}
			);
		if (path === '/sim/state') return json(res, 200, api.state());
		if (path === '/sim/plan') {
			api.setPlan(body.active === true);
			return json(res, 200, {});
		}
		if (path === '/sim/unlink') {
			api.unlink();
			return json(res, 200, {});
		}
		if (path === '/sim/decide')
			return json(
				res,
				200,
				await api.decide(
					String(body.requestId),
					body.decision === 'decline' ? 'decline' : 'approve',
					String(body.reply ?? ''),
					typeof body.version === 'number' ? body.version : undefined
				)
			);
		json(res, 404, { error: 'Not found.' });
	});

	server.on('upgrade', (req, raw: Duplex) => {
		const ticket = new URL(req.url ?? '/', 'http://x').searchParams.get('ticket') ?? '';
		const deviceId = tickets.get(ticket);
		tickets.delete(ticket);
		const device = devices.find((d) => d.id === deviceId);
		const key = req.headers['sec-websocket-key'];
		if (!device || typeof key !== 'string') {
			raw.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
			return;
		}
		const accept = createHash('sha1')
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest('base64');
		raw.write(
			`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`
		);
		const ws = frames(raw, (text) => onMessage(text));
		socket = ws;
		hello = null;
		raw.on('close', () => {
			if (socket === ws) socket = null;
		});

		function onMessage(text: string) {
			if (text === 'ping') return ws.send('pong');
			let m: { type?: string; [k: string]: unknown };
			try {
				m = JSON.parse(text);
			} catch {
				return ws.close(1007, 'Invalid JSON.');
			}
			if (m.type === 'hello') {
				if (m.protocol !== 1)
					return ws.close(4400, 'Update Family Print Lab to use Print Lab Cloud.');
				hello = { app: m.app as string, protocol: m.protocol as number };
				return ws.send(JSON.stringify({ type: 'welcome', account: device!.account, plan }));
			}
			if (m.type === 'requests') requests = (m.requests as Summary[]) ?? [];
			if (m.type === 'printer') {
				printer = m.printer;
				printerMessages++;
			}
			if (m.type === 'result') {
				waiting.get(m.commandId as string)?.({
					ok: m.ok === true,
					error: m.error as string | undefined
				});
				waiting.delete(m.commandId as string);
			}
		}
	});

	return new Promise((resolve) =>
		server.listen(port, host, () => {
			const address = server.address() as { port: number };
			url = `http://${host}:${address.port}`;
			resolve(api);
		})
	);
}

/** Minimal RFC 6455 framing for the server side: masked client frames in, unmasked frames out. */
function frames(raw: Duplex, onText: (text: string) => void): Socket {
	let buffer = Buffer.alloc(0);
	let parts: Buffer[] = [];
	const write = (opcode: number, payload: Buffer) => {
		const len = payload.length;
		const head =
			len < 126
				? Buffer.from([0x80 | opcode, len])
				: len < 65536
					? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
					: Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(len)]);
		if (!raw.destroyed) raw.write(Buffer.concat([head, payload]));
	};
	const socket: Socket = {
		send: (text) => write(1, Buffer.from(text)),
		close: (code, reason) => {
			const p = Buffer.alloc(2 + Buffer.byteLength(reason));
			p.writeUInt16BE(code);
			p.write(reason, 2);
			write(8, p);
			raw.end();
		}
	};
	raw.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			if (buffer.length < 2) return;
			const fin = (buffer[0] & 0x80) !== 0;
			const opcode = buffer[0] & 0x0f;
			let len = buffer[1] & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (buffer.length < 4) return;
				len = buffer.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (buffer.length < 10) return;
				len = Number(buffer.readBigUInt64BE(2));
				offset = 10;
			}
			const masked = (buffer[1] & 0x80) !== 0;
			const maskAt = offset;
			if (masked) offset += 4;
			if (buffer.length < offset + len) return;
			const payload = Buffer.from(buffer.subarray(offset, offset + len));
			if (masked) for (let i = 0; i < len; i++) payload[i] ^= buffer[maskAt + (i % 4)];
			buffer = buffer.subarray(offset + len);
			if (opcode === 8) return socket.close(1000, '');
			if (opcode === 9) write(10, payload);
			if (opcode === 1 || opcode === 0) {
				parts.push(payload);
				if (fin) {
					onText(Buffer.concat(parts).toString('utf8'));
					parts = [];
				}
			}
		}
	});
	raw.on('error', () => raw.destroy());
	return socket;
}

function bigLength(n: number) {
	const b = Buffer.alloc(8);
	b.writeBigUInt64BE(BigInt(n));
	return b;
}

// CLI: npx tsx tools/cloud-sim.ts --port 18881
if (import.meta.url === `file://${process.argv[1]}`) {
	const i = process.argv.indexOf('--port');
	const sim = await startCloudSim(i > 0 ? Number(process.argv[i + 1]) : 18881);
	console.log(`Print Lab Cloud simulator on ${sim.url}`);
}
