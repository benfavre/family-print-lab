// The printer write routes against a test lab: the commands route passes the command layer's
// answers on as HTTP statuses (and the kid-mode refusals are in kid/session.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../testing/harness';
import { POST as command } from '../../../routes/api/printers/[id]/commands/+server';

let t: TestLab;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	t = await startTestLab({ modules: [], fleet: ['C12'] });
	// The routes use the process runtime; point it at the test lab's.
	holder[key] = t.rt;
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

async function send(id: string, body: unknown) {
	const res = await command({
		params: { id },
		request: new Request('http://localhost/api/printers/x/commands', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as unknown as RequestEvent);
	return { status: res.status, body: await res.json() };
}

describe('POST /api/printers/[id]/commands', () => {
	it('runs a command and says how it went', async () => {
		const id = t.printer('C12').info.id;
		expect(await send(id, { name: 'pushing.pushall' })).toEqual({
			status: 200,
			body: { outcome: 'sent' }
		});
	});

	it('answers 400 for an unknown command, 404 for a missing printer, 409 for a guarded one', async () => {
		const id = t.printer('C12').info.id;
		expect((await send(id, { name: 'print.nope' })).status).toBe(400);
		expect((await send('missing', { name: 'pushing.pushall' })).status).toBe(404);
		expect(await send(id, { name: 'print.pause' })).toEqual({
			status: 409,
			body: { error: 'Only a running print can pause.' }
		});
	});
});
