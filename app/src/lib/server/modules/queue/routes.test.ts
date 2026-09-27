// The queue's API routes against a test lab (with the dispatcher paused for the printer, so nothing
// starts while the routes are exercised).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../../testing/harness';
import { fakeSliced } from '../../printer/sliced';
import * as list from '../../../../routes/api/queue/+server';
import * as one from '../../../../routes/api/queue/[id]/+server';
import * as reorder from '../../../../routes/api/queue/reorder/+server';
import * as settings from '../../../../routes/api/queue/settings/+server';
import * as printer from '../../../../routes/api/queue/printers/[id]/+server';

let t: TestLab;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	t = await startTestLab({ modules: ['queue'], fleet: ['C12'] });
	holder[key] = t.rt;
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

type Handler = (event: RequestEvent) => Response | Promise<Response>;
async function call(
	fn: Handler,
	method: string,
	body?: unknown,
	params: Record<string, string> = {}
) {
	const res = await fn({
		params,
		request: new Request('http://localhost/api/queue', {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	} as unknown as RequestEvent);
	return { status: res.status, body: await res.json() };
}

function queuedJob(title: string) {
	const { lab, printing } = t.rt;
	const profileId =
		lab.snapshot().profiles[0]?.id ?? lab.createProfile({ name: 'Sam', color: 'blue' });
	const jobId = lab.createJob({ projectId: lab.createProject({ profileId, title }) });
	printing.attach(
		jobId,
		fakeSliced({ minutes: 30, grams: 5, printerModelId: 'C12' }),
		'a.gcode.3mf'
	);
	return jobId;
}

describe('/api/queue', () => {
	it('adds, lists, holds, reorders and removes items', async () => {
		const id = t.printer('C12').info.id;
		expect((await call(printer.POST, 'POST', { paused: true }, { id })).status).toBe(200);
		const a = queuedJob('Alpha');
		const b = queuedJob('Beta');
		const added = await call(list.POST, 'POST', { jobId: a, printerId: id });
		expect(added.status).toBe(200);
		expect(added.body.item).toMatchObject({ jobId: a, printerId: id, status: 'waiting' });
		const second = (await call(list.POST, 'POST', { jobId: b, printerId: null })).body.item;

		const got = await call(list.GET, 'GET');
		expect(got.body.items.map((i: { title: string }) => i.title)).toEqual([
			'Alpha v01',
			'Beta v01'
		]);
		expect(got.body.items[0].waitingFor).toBe('The queue is paused for this printer.');
		expect(got.body.printers[0]).toMatchObject({ printerId: id, paused: true, autoDispatch: true });

		const held = await call(one.PATCH, 'PATCH', { hold: true }, { id: second.id });
		expect(held.body.item).toMatchObject({ status: 'held', reason: null });
		const moved = await call(reorder.POST, 'POST', {
			printerId: id,
			ids: [second.id, added.body.item.id]
		});
		expect(moved.body.queue.items.map((i: { jobId: string }) => i.jobId)).toEqual([b, a]);
		expect((await call(one.DELETE, 'DELETE', undefined, { id: second.id })).status).toBe(200);
		expect((await call(list.GET, 'GET')).body.items).toHaveLength(1);
	});

	it('answers 400 for bad input, 404 for unknown items and printers, 409 for jobs that cannot queue', async () => {
		expect((await call(list.POST, 'POST', { jobId: 5 })).status).toBe(400);
		expect((await call(list.POST, 'POST', { jobId: 'missing' })).status).toBe(404);
		expect((await call(one.PATCH, 'PATCH', { hold: true }, { id: 'missing' })).status).toBe(404);
		expect((await call(printer.POST, 'POST', { paused: true }, { id: 'missing' })).status).toBe(
			404
		);
		const done = queuedJob('Done');
		t.rt.lab.transitionJob(done, { to: 'Printing', from: 'Queued' });
		expect(await call(list.POST, 'POST', { jobId: done })).toEqual({
			status: 409,
			body: { error: 'Only a queued job can join the queue.' }
		});
	});

	it('saves quiet hours and refuses a window that starts when it ends', async () => {
		const quietHours = Array.from({ length: 7 }, () => ({
			on: true,
			start: '22:00',
			end: '07:00'
		}));
		const saved = await call(settings.PUT, 'PUT', { quietHours, requirePlateClear: false });
		expect(saved.status).toBe(200);
		expect((await call(settings.GET, 'GET')).body).toEqual({
			quietHours,
			requirePlateClear: false
		});
		const bad = quietHours.map((w, i) => (i ? w : { on: true, start: '09:00', end: '09:00' }));
		expect(
			(await call(settings.PUT, 'PUT', { quietHours: bad, requirePlateClear: true })).status
		).toBe(400);
	});
});
