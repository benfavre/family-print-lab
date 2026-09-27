// The AMS and Spoolman routes against a test lab (status codes and bodies the UI relies on).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../../testing/harness';
import { GET as state } from '../../../../routes/api/printers/[id]/ams/+server';
import {
	POST as link,
	DELETE as unlink
} from '../../../../routes/api/printers/[id]/ams/links/+server';
import { POST as add } from '../../../../routes/api/printers/[id]/ams/add/+server';
import { POST as traySettings } from '../../../../routes/api/printers/[id]/ams/tray/+server';
import { POST as drying } from '../../../../routes/api/printers/[id]/ams/drying/+server';
import { POST as reconcile } from '../../../../routes/api/printers/[id]/ams/reconcile/+server';
import { GET as spoolmanGet, PUT as spoolmanPut } from '../../../../routes/api/spoolman/+server';

let t: TestLab;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	t = await startTestLab({ modules: ['ams'], fleet: ['C12'] });
	holder[key] = t.rt;
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

async function call(handler: RequestHandler, method: string, body?: unknown, search = '') {
	const id = t.printer('C12').info.id;
	const res = await handler({
		params: { id },
		url: new URL(`http://localhost/api/x${search}`),
		request: new Request(`http://localhost/api/x${search}`, {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	} as unknown as RequestEvent);
	return { status: res.status, body: await res.json() };
}

describe('AMS routes', () => {
	it('adds a tray to the shelf, lists, unlinks and links again', async () => {
		const added = await call(add, 'POST', { tray: 0 });
		expect(added.status).toBe(200);
		const spoolId = added.body.spoolId;
		expect(added.body.workspace.spools.find((s: { id: string }) => s.id === spoolId)).toMatchObject(
			{
				brand: 'Bambu Lab',
				rfidUuid: expect.stringMatching(/^[0-9A-F]{32}$/)
			}
		);
		expect((await call(state, 'GET')).body.links).toMatchObject([{ tray: 0, spoolId }]);
		expect((await call(unlink, 'DELETE', undefined, '?tray=0')).body.links).toEqual([]);
		expect((await call(link, 'POST', { tray: 0, spoolId })).body.links).toMatchObject([
			{ tray: 0 }
		]);
		expect((await call(add, 'POST', { tray: 0 })).status).toBe(409);
		expect((await call(add, 'POST', { tray: 2 })).body).toEqual({ error: 'That tray is empty.' });
		expect((await call(link, 'POST', { tray: 99, spoolId })).status).toBe(400);
		expect((await call(reconcile, 'POST', { tray: 0 })).status).toBe(409);
	});

	it('sends tray settings and refuses what the AMS cannot do', async () => {
		const res = await call(traySettings, 'POST', {
			tray: 2,
			material: 'PETG',
			colorHex: '#00aa00',
			tempMin: 220,
			tempMax: 260
		});
		expect(res).toMatchObject({ status: 200, body: { outcome: 'confirmed' } });
		expect(
			(
				await call(traySettings, 'POST', {
					tray: 3,
					material: 'PLA',
					colorHex: '#000000',
					tempMin: 190,
					tempMax: 230
				})
			).body.error
		).toMatch(/RFID/);
		const dry = await call(drying, 'POST', { action: 'start', amsId: 0, temp: 55, hours: 4 });
		expect(dry.status).toBe(409);
	});

	it('keeps the Spoolman token on the server', async () => {
		const saved = await call(spoolmanPut, 'PUT', {
			enabled: false,
			url: 'http://spoolman.local:7912',
			token: 'abc'
		});
		expect(saved.body.spoolman).toMatchObject({ hasToken: true, enabled: false });
		const got = await call(spoolmanGet, 'GET');
		expect(got.body).toMatchObject({ url: 'http://spoolman.local:7912', hasToken: true });
		expect(JSON.stringify(got.body)).not.toContain('abc');
		expect((await call(spoolmanPut, 'PUT', { enabled: true, url: 'ftp://x' })).status).toBe(400);
	});
});
