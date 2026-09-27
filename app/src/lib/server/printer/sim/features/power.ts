// A simulated printer on a fake smart plug. Switched off, the printer really goes away: its MQTT and
// file connections close and new sessions are rejected, so the app sees it offline. The listeners
// stay reserved during the cut: another test cannot take their ports. A running print is lost and
// it cools down; switched on, it boots idle after a short delay and accepts sessions again.
// The fake plug speaks the local HTTP APIs the home-automation module drives (Tasmota, Shelly Gen1,
// Shelly Gen2+ RPC with optional digest login, Home Assistant REST, plain webhooks), so tests and
// `bun run dev:sim -- --plugs <port>` exercise the real clients.
import crypto from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import type { SimFeature, SimPrinter, Simulator } from '../core';

export interface SimPlug {
	readonly on: boolean;
	/** Resolves once the printer is gone (off) or listening again (on). */
	set(on: boolean): Promise<void>;
}

const attached = new WeakMap<SimPrinter, SimPlug>();

/** Puts a simulator on a fake plug (it starts switched on). `bootMs`: time from power to listening. */
export function attachPlug(
	simulator: Simulator,
	o: { host?: string; bootMs?: number } = {}
): SimPlug {
	const sim = simulator.sim;
	const existing = attached.get(sim);
	if (existing) return existing;
	let on = true;
	let busy: Promise<void> = Promise.resolve();
	const plug: SimPlug = {
		get on() {
			return on;
		},
		set(next) {
			busy = busy.then(async () => {
				if (next === on) return;
				on = next;
				if (!next) {
					powerCut(sim);
					simulator.setPowered(false);
					sim.log('⏻ plug off: printer unpowered');
				} else {
					sim.log('⏻ plug on: printer booting');
					await new Promise((r) => setTimeout(r, o.bootMs ?? 1000));
					if (!on) return;
					simulator.setPowered(true);
					sim.log('⏻ printer ready');
				}
			});
			return busy;
		}
	};
	attached.set(sim, plug);
	return plug;
}

/** What losing power does to the printer: the print is gone, heaters off, back to idle at room temperature. */
function powerCut(sim: SimPrinter) {
	sim.job = null;
	Object.assign(sim.state, {
		gcode_state: 'IDLE',
		mc_percent: 0,
		mc_remaining_time: 0,
		layer_num: 0,
		print_error: 0,
		stg_cur: 255,
		print_type: 'idle',
		hms: []
	});
	sim.setActiveTray(null);
	sim.setTemps({ nozzle: 25, nozzleTarget: 0, bed: 25, bedTarget: 0, chamber: 25 });
}

export const power: SimFeature = {
	key: 'power',
	controls: [
		{
			id: 'plug-off',
			label: 'Plug: off',
			run: (sim) => {
				const plug = attached.get(sim);
				if (!plug) return sim.log('No fake plug: start the simulator with --plugs <port>.');
				void plug.set(false);
			}
		},
		{
			id: 'plug-on',
			label: 'Plug: on',
			run: (sim) => {
				const plug = attached.get(sim);
				if (!plug) return sim.log('No fake plug: start the simulator with --plugs <port>.');
				void plug.set(true);
			}
		}
	]
};

export interface FakePlugServer {
	port: number;
	/** Every request, as "METHOD /path?query". */
	requests: string[];
	close(): Promise<void>;
}

/**
 * A fake smart plug on 127.0.0.1 answering every supported API at once. Optional logins: `user` +
 * `password` (Tasmota query parameters, Shelly Gen1 Basic auth), `password` alone with `digest`
 * (Shelly Gen2+, user "admin"), `token` (Home Assistant bearer token).
 */
export async function createFakePlug(o: {
	plug: { on: boolean; set(on: boolean): unknown };
	port?: number;
	user?: string;
	password?: string;
	digest?: boolean;
	token?: string;
	entityId?: string;
}): Promise<FakePlugServer> {
	const requests: string[] = [];
	const realm = 'shellyplus1pm-sim';
	const nonce = crypto.randomBytes(12).toString('base64');
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://plug');
		requests.push(`${req.method} ${url.pathname}${url.search}`);
		const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(status, { 'content-type': 'application/json', ...headers });
			res.end(JSON.stringify(body));
		};
		const set = async (on: boolean) => {
			await o.plug.set(on);
		};
		const was = o.plug.on;
		void (async () => {
			try {
				// Tasmota
				if (url.pathname === '/cm') {
					if (
						o.password &&
						(url.searchParams.get('user') !== (o.user ?? 'admin') ||
							url.searchParams.get('password') !== o.password)
					)
						return send(401, { WARNING: 'Need user=<username>&password=<password>' });
					const cmnd = (url.searchParams.get('cmnd') ?? '').trim().toLowerCase();
					if (cmnd === 'power on') void set(true);
					else if (cmnd === 'power off') void set(false);
					else if (cmnd !== 'power') return send(200, { Command: 'Unknown' });
					const on = cmnd === 'power' ? o.plug.on : cmnd === 'power on';
					return send(200, { POWER: on ? 'ON' : 'OFF' });
				}
				// Shelly Gen1
				const relay = url.pathname.match(/^\/relay\/(\d+)$/);
				if (relay) {
					if (o.password && !o.digest) {
						const expected = `Basic ${Buffer.from(`${o.user ?? ''}:${o.password}`).toString('base64')}`;
						if (req.headers.authorization !== expected) return send(401, {});
					}
					const turn = url.searchParams.get('turn');
					if (turn === 'on' || turn === 'off') void set(turn === 'on');
					return send(200, { ison: turn ? turn === 'on' : o.plug.on, has_timer: false });
				}
				// Shelly Gen2+ RPC
				if (url.pathname.startsWith('/rpc/')) {
					if (o.password && o.digest && !digestOk(req, realm, nonce, o.password))
						return send(
							401,
							{ code: 401, message: 'Unauthorized' },
							{
								'www-authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}", algorithm=SHA-256`
							}
						);
					if (url.pathname === '/rpc/Switch.Set') {
						const on = url.searchParams.get('on') === 'true';
						void set(on);
						return send(200, { was_on: was });
					}
					if (url.pathname === '/rpc/Switch.GetStatus')
						return send(200, { id: Number(url.searchParams.get('id') ?? 0), output: o.plug.on });
					return send(404, { code: 404, message: 'No handler' });
				}
				// Home Assistant
				if (url.pathname.startsWith('/api/')) {
					if (o.token && req.headers.authorization !== `Bearer ${o.token}`)
						return send(401, { message: 'Unauthorized' });
					const service = url.pathname.match(/^\/api\/services\/(\w+)\/(turn_on|turn_off)$/);
					if (service && req.method === 'POST') {
						const body = JSON.parse((await readBody(req)) || '{}');
						if (o.entityId && body.entity_id !== o.entityId)
							return send(400, { message: 'Bad entity' });
						void set(service[2] === 'turn_on');
						return send(200, []);
					}
					const state = url.pathname.match(/^\/api\/states\/(.+)$/);
					if (state) {
						if (o.entityId && decodeURIComponent(state[1]) !== o.entityId)
							return send(404, { message: 'Entity not found.' });
						return send(200, {
							entity_id: decodeURIComponent(state[1]),
							state: o.plug.on ? 'on' : 'off'
						});
					}
				}
				// Webhooks
				if (url.pathname === '/on' || url.pathname === '/off') {
					void set(url.pathname === '/on');
					return send(200, { ok: true });
				}
				send(404, { error: 'Not found' });
			} catch (error) {
				send(500, { error: (error as Error).message });
			}
		})();
	});
	const port = await new Promise<number>((resolve, reject) => {
		server.once('error', reject);
		server.listen(o.port ?? 0, '127.0.0.1', () =>
			resolve((server.address() as net.AddressInfo).port)
		);
	});
	return {
		port,
		requests,
		close: () =>
			new Promise((r) => {
				server.closeAllConnections();
				server.close(() => r());
			})
	};
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = '';
		req.on('data', (c) => (body = (body + c).slice(0, 10_000)));
		req.on('end', () => resolve(body));
	});
}

/** Checks a SHA-256 digest answer the way a Shelly Gen2+ device does (user "admin"). */
function digestOk(req: http.IncomingMessage, realm: string, nonce: string, password: string) {
	const header = req.headers.authorization ?? '';
	if (!/^Digest /i.test(header)) return false;
	const p: Record<string, string> = {};
	for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]] = m[2] ?? m[3];
	const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
	if (p.username !== 'admin' || p.realm !== realm || p.nonce !== nonce) return false;
	const ha1 = h(`admin:${realm}:${password}`);
	const ha2 = h(`${req.method}:${p.uri}`);
	return p.uri === req.url && p.response === h(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`);
}
