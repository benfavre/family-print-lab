// The hms module against a simulated X2D: a runout raises plain-words alerts with Bambu's button,
// pressing it resumes the print and closes the history rows, and a failed print keeps its error on
// the job. Routes are called directly, pointed at the test lab's runtime.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '$lib/server/testing/harness';
import { fakeSliced } from '$lib/server/printer/sliced';
import { hms as simHms } from '$lib/server/printer/sim/features/hms';
import type { SimPrinter } from '$lib/server/printer/sim/core';
import type { HmsEventRow, HmsPrinterView } from '$lib/shared/hms';
import { GET as printerHms } from '../../../../routes/api/printers/[id]/hms/+server';
import { POST as pressAction } from '../../../../routes/api/printers/[id]/hms/action/+server';
import { GET as lookup } from '../../../../routes/api/hms/lookup/+server';
import { GET as jobEvents } from '../../../../routes/api/hms/jobs/[jobId]/+server';

let t: TestLab;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	t = await startTestLab({ modules: ['hms'], fleet: ['N6'] });
	holder[key] = t.rt;
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

async function until(check: () => unknown, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error('Timed out waiting for condition');
}

async function call(
	handler: (e: RequestEvent) => Promise<Response> | Response,
	url: string,
	params: Record<string, string>,
	body?: unknown
) {
	const res = await handler({
		params,
		url: new URL(url, 'http://localhost'),
		request: new Request(new URL(url, 'http://localhost'), {
			method: body === undefined ? 'GET' : 'POST',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	} as unknown as RequestEvent);
	return { status: res.status, body: await res.json() };
}

const control = (sim: SimPrinter, id: string) =>
	simHms.controls!.find((c) => c.id === id)!.run(sim, {});

/** A job printing on the X2D, running (heating done). */
async function printing() {
	const { lab: l, printing: files } = t.rt;
	const x2d = t.printer('N6');
	const profileId = l.createProfile({ name: 'Alex', color: 'blue' });
	const projectId = l.createProject({ profileId, title: 'Desk hook' });
	const jobId = l.createJob({ projectId });
	files.attach(
		jobId,
		fakeSliced({ minutes: 60, grams: 12, printerModelId: 'N6' }),
		'hook.gcode.3mf'
	);
	files.send(jobId, { printerId: x2d.info.id, useAms: true, amsMapping: [0] });
	await until(() => x2d.sim.state.gcode_state === 'RUNNING');
	await until(() => t.rt.lab.getJob(jobId)?.printerTask);
	return { jobId, ...x2d };
}

describe('hms module with a simulated printer', () => {
	it('describes a runout, resolves it with Bambu’s button, and keeps the history', async () => {
		const { jobId, info, sim } = await printing();
		const service = t.rt.module('hms')!;
		const raised = t.nextEvent('hms.raised');
		control(sim, 'ams-runout');
		await raised;
		await until(() => service.active(info.id).length === 2);

		const view = (await call(printerHms, `/api/printers/${info.id}/hms`, { id: info.id }))
			.body as HmsPrinterView;
		const [alert, error] = [
			view.active.find((a) => a.kind === 'hms')!,
			view.active.find((a) => a.kind === 'print_error')!
		];
		expect(alert).toMatchObject({
			severity: 'serious',
			module: 'ams',
			known: true,
			actions: []
		});
		expect(alert.code).toMatch(/^070\d_2\d00_0002_0001$/);
		expect(alert.text).toMatch(/^AMS [A-D] Slot [1-4] filament has run out/);
		expect(alert.wikiUrl).toMatch(/^https:\/\/wiki\.bambulab\.com\/en\//);
		expect(error).toMatchObject({
			code: '0700_8011',
			severity: 'common',
			text: 'AMS filament ran out. Please insert a new filament into the same AMS slot.',
			actions: [{ id: 4, label: 'Resume (problem solved)', command: 'print.resume:hms' }]
		});
		expect(error.image).toMatch(/^\/api\/hms\/image\/[0-9a-f]{32}\.webp$/);
		// Worst first.
		expect(view.active[0].kind).toBe('hms');
		await until(() => service.history(info.id).rows.length === 2);
		expect(service.history(info.id).rows.every((r) => r.jobId === jobId && !r.clearedAt)).toBe(
			true
		);
		expect(service.history(info.id, { severity: ['serious'] }).total).toBe(1);

		// A button that is not the alert's is refused; the right one resumes the print.
		expect(
			(await call(pressAction, '/', { id: info.id }, { code: '0700_8011', actionId: 5 })).status
		).toBe(400);
		const pressed = await call(
			pressAction,
			'/',
			{ id: info.id },
			{ code: '0700_8011', actionId: 4 }
		);
		expect(pressed.status).toBe(200);
		expect(pressed.body.outcome).toBe('confirmed');
		await until(() => service.active(info.id).length === 0);
		expect(sim.state.gcode_state).toBe('RUNNING');
		await until(() => service.history(info.id).rows.every((r) => r.clearedAt));
		expect(
			(await call(pressAction, '/', { id: info.id }, { code: '0700_8011', actionId: 4 })).status
		).toBe(409);

		// A failed print keeps its error on the job.
		const failed = t.nextEvent('print.failed');
		control(sim, 'fail-clog');
		expect((await failed).jobId).toBe(jobId);
		expect(t.rt.lab.getJob(jobId)?.status).toBe('Failed');
		const events = (await call(jobEvents, '/', { jobId })).body.events as HmsEventRow[];
		expect(events[0]).toMatchObject({ kind: 'print_error', code: '03008016', jobId });
		expect(events[0].text).toMatch(/nozzle is clogged/);
		// The failed print's error stays active until the printer clears it (Bambu's OK button isn't
		// offered for this code; resume and stop are).
		await until(() => service.active(info.id).some((a) => a.key === '03008016'));
	});

	it('looks codes up for a printer, a model or no one', async () => {
		const id = t.printer('N6').info.id;
		const forPrinter = await call(lookup, `/api/hms/lookup?code=0300_400C&printerId=${id}`, {});
		expect(forPrinter.body).toMatchObject({ kind: 'print_error', text: 'The task was canceled.' });
		const forModel = await call(lookup, '/api/hms/lookup?code=0700200000020001&model=C12', {});
		expect(forModel.body).toMatchObject({ kind: 'hms', severity: 'serious', known: true });
		const unknown = await call(lookup, '/api/hms/lookup?code=0FFF_FFFF_0001_0001', {});
		expect(unknown.body).toMatchObject({
			known: false,
			wikiUrl: 'https://wiki.bambulab.com/en/hms/home'
		});
		expect((await call(lookup, '/api/hms/lookup?code=nope', {})).status).toBe(400);
	});
});
