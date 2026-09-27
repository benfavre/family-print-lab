// The module against a simulated printer on a fake smart plug: a job sent to a printer that is off
// switches it on, prints, and switches it off once cooled. Then the routes: plugs never give their
// secrets back, and Home Assistant / metrics access needs this computer or the token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../../testing/harness';
import { fakeSliced } from '../../printer/sliced';
import {
	attachPlug,
	createFakePlug,
	type FakePlugServer,
	type SimPlug
} from '../../printer/sim/features/power';
import { timings } from './module';
import { GET as listPlugs, POST as addPlug } from '../../../../routes/api/plugs/+server';
import { PATCH as patchPlug } from '../../../../routes/api/plugs/[id]/+server';
import { POST as powerRoute } from '../../../../routes/api/plugs/[id]/power/+server';
import { POST as testRoute } from '../../../../routes/api/plugs/[id]/test/+server';
import { GET as haPrinters } from '../../../../routes/api/ha/printers/+server';
import {
	PATCH as patchSettings,
	GET as getSettings
} from '../../../../routes/api/ha/settings/+server';
import { POST as makeToken } from '../../../../routes/api/ha/token/+server';
import { GET as metrics } from '../../../../routes/metrics/+server';

let t: TestLab;
let plug: SimPlug;
let fake: FakePlugServer;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

async function until(fn: () => boolean, ms = 10_000) {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error('Timed out');
		await new Promise((r) => setTimeout(r, 20));
	}
}

beforeAll(async () => {
	timings.override = { pollMs: 50, retryMs: 300, offCheckMs: 100 };
	t = await startTestLab({ fleet: ['C12'], modules: ['home-automation'] });
	holder[key] = t.rt;
	plug = attachPlug(t.fleet.printers[0].sim, { bootMs: 300 });
	fake = await createFakePlug({ plug });
});
afterAll(async () => {
	delete holder[key];
	delete timings.override;
	await fake.close();
	await t.stop();
});

function event(
	url: string,
	o: {
		method?: string;
		body?: unknown;
		params?: Record<string, string>;
		from?: string;
		headers?: Record<string, string>;
	} = {}
) {
	return {
		params: o.params ?? {},
		url: new URL(url, 'http://localhost'),
		locals: { kid: null },
		getClientAddress: () => o.from ?? '127.0.0.1',
		request: new Request(new URL(url, 'http://localhost'), {
			method: o.method ?? 'GET',
			headers: {
				...(o.body !== undefined && { 'content-type': 'application/json' }),
				...o.headers
			},
			body: o.body === undefined ? undefined : JSON.stringify(o.body)
		})
	} as unknown as RequestEvent;
}
// Handlers typed per route; the fake event suits them all.
type Handler = (e: never) => Response | Promise<Response>;
async function call(fn: Handler, url: string, o: Parameters<typeof event>[1] = {}) {
	const res = await fn(event(url, o) as never);
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* text/plain */
	}
	return { status: res.status, body: body as Record<string, never>, headers: res.headers };
}

describe('home automation with a simulated printer on a fake plug', () => {
	it('powers a printer on for a queued job, prints, and powers it off after cooling', async () => {
		const { info } = t.printer('C12');
		const ha = t.rt.module('home-automation')!;
		expect(t.rt.hooks.beforeDispatch.size).toBe(0);
		const created = await call(addPlug as Handler, '/api/plugs', {
			method: 'POST',
			body: {
				printerId: info.id,
				kind: 'tasmota',
				config: { url: `http://127.0.0.1:${fake.port}` },
				autoOn: true,
				autoOff: true,
				cooldownMinutes: 0,
				offBelowNozzle: 50
			}
		});
		expect(created.status).toBe(200);
		// Now something can wake printers up.
		expect(t.rt.hooks.beforeDispatch.size).toBe(1);

		await plug.set(false);
		const conn = t.rt.printers.get(info.id)!;
		await until(() => !conn.connected);

		const { lab, printing } = t.rt;
		const profileId = lab.createProfile({ name: 'Ana', color: 'pink' });
		const projectId = lab.createProject({ profileId, title: 'Badge' });
		const jobId = lab.createJob({ projectId });
		printing.attach(
			jobId,
			fakeSliced({ minutes: 1, grams: 3, printerModelId: 'C12' }),
			'b.gcode.3mf'
		);

		const opts = { printerId: info.id, useAms: true, amsMapping: [0] };
		expect(printing.check(jobId, opts).blocking).toContain('The printer is not connected.');
		expect(printing.check(jobId, { ...opts, wake: true }).blocking).toEqual([]);

		const on = t.nextEvent('power.on', undefined, 10_000);
		const finished = t.nextEvent('print.finished', undefined, 40_000);
		const off = t.nextEvent('power.off', undefined, 60_000);
		printing.send(jobId, { ...opts, wake: true });
		expect(await on).toMatchObject({ printerId: info.id, reason: 'print', printerName: info.name });
		await finished;
		expect(lab.getJob(jobId)?.status).toBe('Succeeded');
		expect(await off).toMatchObject({ printerId: info.id, reason: 'auto' });
		expect(plug.on).toBe(false);
		// It was cool when the plug went off.
		expect(conn.snapshot!.nozzle!).toBeLessThan(50);
		expect(fake.requests).toContain('GET /cm?cmnd=Power%20On');
		expect(fake.requests).toContain('GET /cm?cmnd=Power%20Off');
		expect(ha.power.state(info.id).on).toBe(false);

		// Back on for the next tests.
		await plug.set(true);
		await until(() => conn.connected, 70_000);
	}, 120_000);

	it('keeps plug secrets out of the API, and tests and switches plugs by hand', async () => {
		const { info } = t.printer('C12');
		const ha = t.rt.module('home-automation')!;
		const saved = ha.plugs.forPrinter(info.id)!;
		const patched = await call(patchPlug as Handler, `/api/plugs/${saved.id}`, {
			method: 'PATCH',
			params: { id: saved.id },
			body: { version: saved.version, config: { user: 'admin', password: 'hunter22' } }
		});
		expect(patched.status).toBe(200);
		expect(JSON.stringify(patched.body)).not.toContain('hunter22');
		expect(patched.body.plug).toMatchObject({ config: { hasPassword: true, user: 'admin' } });
		expect(ha.plugs.forPrinter(info.id)!.config.password).toBe('hunter22');
		// An empty password keeps it; null clears it.
		const again = ha.plugs.update(saved.id, {
			version: saved.version + 1,
			config: { password: '' }
		});
		expect(again.config.password).toBe('hunter22');
		ha.plugs.update(saved.id, { version: again.version, config: { password: null } });

		const list = await call(listPlugs as Handler, '/api/plugs');
		expect(JSON.stringify(list.body)).not.toContain('hunter22');
		expect(list.body.plugs).toHaveLength(1);

		const tested = await call(testRoute as Handler, `/api/plugs/${saved.id}/test`, {
			method: 'POST',
			params: { id: saved.id }
		});
		expect(tested.body).toMatchObject({ ok: true, on: true });

		// Printing: switching off by hand is refused.
		const sim = t.fleet.printers[0].sim;
		sim.start({ minutes: 30 });
		await until(() => !!t.rt.printers.get(info.id)!.status().printing);
		const refused = await call(powerRoute as Handler, `/api/plugs/${saved.id}/power`, {
			method: 'POST',
			params: { id: saved.id },
			body: { on: false }
		});
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/Not switching off: The printer is printing/);
		expect(plug.on).toBe(true);
		sim.stop();
	});

	it('serves Home Assistant and metrics only when on, locally or with the token', async () => {
		expect((await call(haPrinters as Handler, '/api/ha/printers')).status).toBe(404);
		expect((await call(metrics as Handler, '/metrics')).status).toBe(404);
		const settings = await call(patchSettings as Handler, '/api/ha/settings', {
			method: 'PATCH',
			body: { ha: { enabled: true }, metrics: { enabled: true } }
		});
		expect(settings.body.settings).toMatchObject({
			ha: { enabled: true },
			token: { hasToken: false }
		});

		// From this computer: allowed.
		const local = await call(haPrinters as Handler, '/api/ha/printers');
		expect(local.status).toBe(200);
		const [p] = local.body.printers as unknown as Record<string, unknown>[];
		expect(p).toMatchObject({ name: t.printer('C12').info.name, online: true, power: true });
		// Printer ids and names only: no serial, access code or address anywhere.
		const text = JSON.stringify(local.body);
		const { sim } = t.printer('C12');
		expect(text).not.toContain(sim.serial);
		expect(text).not.toContain('127.0.0.1');
		expect(text).not.toContain(t.fleet.printers[0].sim.accessCode);

		// From elsewhere: the token, or nothing. Headers a client sets do not make it local.
		const remote = { from: '192.168.1.50', headers: { 'x-forwarded-for': '127.0.0.1' } };
		const refused = await call(haPrinters as Handler, '/api/ha/printers', remote);
		expect(refused.status).toBe(401);
		expect(refused.headers.get('www-authenticate')).toMatch(/^Bearer/);
		expect((await call(metrics as Handler, '/metrics', remote)).status).toBe(401);
		const made = await call(makeToken as Handler, '/api/ha/token', { method: 'POST', body: {} });
		const token = made.body.token as string;
		expect(token).toMatch(/^plab_/);
		const stored = t.rt.module('home-automation')!.settings().tokenHash;
		expect(stored).toMatch(/^[0-9a-f]{64}$/);
		expect(stored).not.toContain(token);
		const auth = { ...remote, headers: { authorization: `Bearer ${token}` } };
		expect((await call(haPrinters as Handler, '/api/ha/printers', auth)).status).toBe(200);
		const wrong = { ...remote, headers: { authorization: `Bearer ${token}x` } };
		expect((await call(haPrinters as Handler, '/api/ha/printers', wrong)).status).toBe(401);

		const m = await call(metrics as Handler, '/metrics', auth);
		expect(m.status).toBe(200);
		expect(m.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
		const body = m.body as unknown as string;
		expect(body).toMatch(
			/^printlab_printer_up\{printer_id="[^"]+",printer="[^"]+",model="C12"\} 1$/m
		);
		expect(body).toMatch(/^printlab_plug_on\{.*\} 1$/m);
		expect(body).toMatch(/^printlab_jobs\{status="succeeded"\} 1$/m);
		expect(body).not.toContain(sim.serial);

		// The view never has the token or the MQTT password.
		const view = await call(getSettings as Handler, '/api/ha/settings');
		expect(JSON.stringify(view.body)).not.toContain(token);
		expect(view.body).toMatchObject({ token: { hasToken: true } });
	});
});
