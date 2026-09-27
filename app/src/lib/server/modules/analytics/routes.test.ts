// The statistics routes against a test lab with the analytics module started.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../../testing/harness';
import { kidAccess } from '../../kid/session';
import { GET as stats } from '../../../../routes/api/analytics/+server';
import { GET as csv } from '../../../../routes/api/analytics/export.csv/+server';

let t: TestLab;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	t = await startTestLab({ modules: ['analytics'], fleet: [] });
	holder[key] = t.rt;
	const lab = t.rt.lab;
	const profileId = lab.createProfile({ name: 'Alex', color: 'blue' });
	const projectId = lab.createProject({ profileId, title: 'Hook, "big"' });
	const spoolId = lab.createSpool({
		material: 'PETG',
		colorHex: '#123456',
		totalGrams: 1000,
		remainingGrams: 1000,
		cost: 30
	});
	lab.createJob({
		projectId,
		spoolId,
		status: 'Succeeded',
		grams: 20,
		actualMinutes: 42,
		finishedAt: '2026-09-20T12:00:00.000Z'
	});
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

const call = (handler: typeof stats, query: string) =>
	handler({
		url: new URL(`http://localhost/api/analytics?${query}`),
		request: new Request(`http://localhost/api/analytics?${query}`)
	} as unknown as RequestEvent);

describe('GET /api/analytics', () => {
	it('answers the summary for a filter', async () => {
		const res = await call(stats, 'from=2026-09-01&to=2026-09-30&tz=60');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.totals).toMatchObject({ prints: 1, grams: 20, cost: 0.6, machineMinutes: 42 });
		expect(body.filter).toEqual({
			from: '2026-09-01',
			to: '2026-09-30',
			printerId: null,
			profileId: null,
			tz: 60
		});
	});

	it('refuses bad dates', async () => {
		expect((await call(stats, 'from=yesterday')).status).toBe(400);
		expect((await call(stats, 'from=2026-10-01&to=2026-09-01')).status).toBe(400);
		expect((await call(stats, 'tz=9999')).status).toBe(400);
	});
});

describe('GET /api/analytics/export.csv', () => {
	it('downloads the finished prints as CSV', async () => {
		const res = await call(csv, 'person=');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
		expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=".+\.csv"/);
		const bytes = Buffer.from(await res.arrayBuffer());
		// UTF-8 byte order mark first, for spreadsheet apps.
		expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const text = bytes.subarray(3).toString('utf8');
		expect(text.startsWith('Finished,Project,')).toBe(true);
		expect(text).toContain(
			'2026-09-20 12:00,"Hook, ""big""",Alex,No printer set,Succeeded,PETG,20,0.6,42,,'
		);
	});
});

describe('kid mode', () => {
	it('keeps the statistics for grown-ups', () => {
		expect(kidAccess('GET', '/api/analytics', '/api/analytics')).toBe('refuse');
		expect(kidAccess('GET', '/api/analytics/export.csv', '/api/analytics/export.csv')).toBe(
			'refuse'
		);
		expect(kidAccess('GET', '/analytics', '/analytics')).toBe('redirect');
	});
});
