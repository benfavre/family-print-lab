// The onboarding module in a test lab: a brand new lab is a first run until a printer or a profile
// exists, or the guide is finished or skipped; the route refuses kid mode and bad actions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../../testing/harness';
import { isFirstRun } from '$lib/shared/onboarding';
import { GET, POST } from '../../../../routes/api/onboarding/+server';

let t: TestLab;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	t = await startTestLab({ fleet: [], modules: ['onboarding'] });
	holder[key] = t.rt;
}, 30_000);
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

async function call(handler: (e: RequestEvent) => Promise<Response> | Response, body?: unknown) {
	const res = await handler({
		params: {},
		locals: { kid: null },
		url: new URL('http://localhost/api/onboarding'),
		request: new Request('http://localhost/api/onboarding', {
			method: body === undefined ? 'GET' : 'POST',
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	} as unknown as RequestEvent);
	return { status: res.status, body: await res.json() };
}

describe('isFirstRun', () => {
	const fresh = { profiles: 0, printers: 0, completedAt: null, skippedAt: null };
	it('is true only for an empty lab that never saw the guide through', () => {
		expect(isFirstRun(fresh)).toBe(true);
		expect(isFirstRun({ ...fresh, profiles: 1 })).toBe(false);
		expect(isFirstRun({ ...fresh, printers: 2 })).toBe(false);
		expect(isFirstRun({ ...fresh, completedAt: '2026-09-27T10:00:00.000Z' })).toBe(false);
		expect(isFirstRun({ ...fresh, skippedAt: '2026-09-27T10:00:00.000Z' })).toBe(false);
	});
});

describe('onboarding module', () => {
	it('reports a first run on a fresh database', async () => {
		const r = await call(GET);
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			firstRun: true,
			profiles: 0,
			printers: 0,
			completedAt: null,
			skippedAt: null
		});
	});

	it('stops being a first run once a profile exists', () => {
		const id = t.rt.lab.createProfile({ name: 'Sam', color: 'blue' });
		expect(t.rt.module('onboarding')!.state()).toMatchObject({ firstRun: false, profiles: 1 });
		t.rt.lab.deleteProfile(id);
		expect(t.rt.module('onboarding')!.state().firstRun).toBe(true);
	});

	it('refuses unknown actions', async () => {
		const r = await call(POST, { action: 'restart' });
		expect(r.status).toBe(400);
	});

	it('remembers a skip, then a finish', async () => {
		const skipped = await call(POST, { action: 'skip' });
		expect(skipped.status).toBe(200);
		expect(skipped.body.state.firstRun).toBe(false);
		expect(skipped.body.state.skippedAt).toMatch(/^\d{4}-/);
		const finished = await call(POST, { action: 'finish' });
		expect(finished.body.state.completedAt).toMatch(/^\d{4}-/);
		expect(finished.body.state.skippedAt).toBe(skipped.body.state.skippedAt);
		// Saved in meta, so a new service over the same database agrees.
		expect(t.rt.module('onboarding')!.state().completedAt).toBe(finished.body.state.completedAt);
	});
});
