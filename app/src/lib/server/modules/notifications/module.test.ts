// The module in a test lab with a simulated printer: a failed print lands in the centre and reaches a
// local fake ntfy server; a switched-off channel sends nothing; the API routes never return secrets.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../../testing/harness';
import { fakeServer } from './testing';
import { described } from './module';
import { runOut } from '../../printer/sim/features/notifications';
import { GET as list, DELETE as clear } from '../../../../routes/api/notifications/+server';
import { POST as read } from '../../../../routes/api/notifications/read/+server';
import {
	GET as getSettings,
	PUT as putSettings
} from '../../../../routes/api/notifications/settings/+server';
import { POST as test } from '../../../../routes/api/notifications/test/+server';

let t: TestLab;
let ntfy: Awaited<ReturnType<typeof fakeServer>>;
let quiet: Awaited<ReturnType<typeof fakeServer>>;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	ntfy = await fakeServer();
	quiet = await fakeServer();
	t = await startTestLab({ modules: ['notifications'], fleet: ['C12'] });
	holder[key] = t.rt;
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
	await ntfy.close();
	await quiet.close();
});

async function call(
	handler: (e: RequestEvent) => Promise<Response> | Response,
	method = 'GET',
	body?: unknown,
	url = 'http://localhost/api/notifications'
) {
	const res = await handler({
		url: new URL(url),
		params: {},
		request: new Request(url, {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	} as unknown as RequestEvent);
	return { status: res.status, body: await res.json() };
}

describe('notifications in a lab', () => {
	it('saves channels without echoing secrets', async () => {
		const saved = await call(putSettings, 'PUT', {
			inApp: ['print.failed', 'print.finished', 'ams.runout', 'print.started'],
			channels: [
				{
					id: 'phone',
					kind: 'ntfy',
					name: 'Phone',
					server: ntfy.url,
					topic: 'lab-test',
					token: 'tk_very_secret',
					events: ['print.failed', 'ams.runout']
				},
				{
					id: 'off',
					kind: 'ntfy',
					server: quiet.url,
					topic: 'lab-off',
					enabled: false,
					events: ['print.failed']
				}
			]
		});
		expect(saved.status).toBe(200);
		expect(JSON.stringify(saved.body.settings)).not.toContain('tk_very_secret');
		const got = await call(getSettings);
		expect(got.body.channels[0]).toMatchObject({ id: 'phone', hasToken: true, topic: 'lab-test' });
		expect(got.body.channels[0]).not.toHaveProperty('token');
		expect(got.body.desktopAvailable).toBe(false);
	});

	it('a simulated failed print creates a notification and one ntfy request', async () => {
		const { sim, info } = t.printer('C12');
		sim.print.start({ name: 'rocket_v2', minutes: 30 });
		await t.nextEvent('print.started');
		const failed = t.nextEvent('print.failed');
		sim.print.fail(0x0300800a, 'spaghetti');
		await failed;
		await t.rt.module('notifications')!.idle();
		const { body } = await call(list);
		expect(body.unread).toBe(1);
		expect(body.items[0]).toMatchObject({
			event: 'print.failed',
			level: 'error',
			title: 'rocket_v2 failed',
			printerId: info.id,
			link: `/printers/${info.id}`
		});
		expect(body.items[0].body).toMatch(/^.+ stopped: Error 0300800A\.$/);
		expect(ntfy.received).toHaveLength(1);
		expect(ntfy.received[0]).toMatchObject({ method: 'POST', url: '/lab-test' });
		expect(ntfy.received[0].headers).toMatchObject({
			'x-title': 'rocket_v2 failed',
			authorization: 'Bearer tk_very_secret'
		});
		expect(quiet.received).toHaveLength(0);
	});

	it('a filament runout in the simulator is told once, as a runout', async () => {
		const { sim } = t.printer('C12');
		sim.print.start({ name: 'dock', minutes: 30 });
		await t.nextEvent('print.started');
		for (let i = 0; i < 250 && sim.state.gcode_state !== 'RUNNING'; i++)
			await new Promise((r) => setTimeout(r, 20));
		const runout = t.nextEvent('ams.runout');
		runOut(sim);
		await runout;
		await t.rt.module('notifications')!.idle();
		const { body } = await call(list);
		expect(body.items[0].event).toBe('ams.runout');
		expect(body.items.filter((i: { event: string }) => i.event === 'print.paused')).toHaveLength(0);
		expect(ntfy.received).toHaveLength(2);
		sim.print.stop();
	});

	it('marks read, clears, and tests a channel with its saved token', async () => {
		const ids = (await call(list)).body.items.map((i: { id: string }) => i.id);
		expect((await call(read, 'POST', { ids: [ids[0]] })).body.unread).toBe(ids.length - 1);
		expect((await call(read, 'POST', { all: true })).body.unread).toBe(0);
		expect((await call(read, 'POST', { ids: [] })).status).toBe(400);

		const before = ntfy.received.length;
		const tested = await call(test, 'POST', {
			channel: { id: 'phone', kind: 'ntfy', server: ntfy.url, topic: 'lab-test', token: '' }
		});
		expect(tested.body.result).toMatchObject({ ok: true, detail: 'Delivered.' });
		expect(ntfy.received[before].headers.authorization).toBe('Bearer tk_very_secret');
		expect((await call(getSettings)).body.channels[0].last).toMatchObject({ ok: true });

		expect((await call(clear, 'DELETE')).body).toMatchObject({ items: [], unread: 0 });
	});

	it('shows up on the Integrations page', async () => {
		const { integrations } = await import('../../integrations');
		const rows = await integrations(t.rt as never);
		expect(rows.items.find((r) => r.id === 'notifications')).toMatchObject({
			available: true,
			detail: '1 channel on, plus the bell.'
		});
	});

	it('uses the hms package’s words only when it knows the code', () => {
		const info = {
			key: '0300800A',
			kind: 'print_error' as const,
			severity: 'serious' as const,
			module: 'toolhead',
			wikiUrl: null,
			actions: []
		};
		expect(described({ ...info, text: 'Spaghetti detected.', known: true })).toBe(
			'Spaghetti detected.'
		);
		expect(described({ ...info, text: 'No description for this code yet.', known: false })).toBe(
			''
		);
		expect(described({ ...info, text: 'Spaghetti detected.' })).toBe('Spaghetti detected.');
	});
});
