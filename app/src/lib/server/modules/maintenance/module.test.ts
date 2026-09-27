// The maintenance module in a test lab: a simulated print adds hours, the task falls due, the event
// fires once, marking it done over the API resets it; nozzle changes reach the simulated printer; the
// firmware offer and the H2C rack show up.
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '$lib/server/testing/harness';
import { fakeSliced } from '$lib/server/printer/sliced';
import { maintenance as simMaintenance } from '$lib/server/printer/sim/features/maintenance';
import type { MaintenanceOverview } from '$lib/shared/maintenance';
import { GET as overviewRoute } from '../../../../routes/api/printers/[id]/maintenance/+server';
import { POST as addRoute } from '../../../../routes/api/printers/[id]/maintenance/tasks/+server';
import { POST as doneRoute } from '../../../../routes/api/printers/[id]/maintenance/tasks/[taskId]/done/+server';
import { POST as nozzleRoute } from '../../../../routes/api/printers/[id]/maintenance/nozzle/+server';
import { PUT as odometerRoute } from '../../../../routes/api/printers/[id]/maintenance/odometer/+server';

const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');
let t: TestLab | null = null;

async function lab(fleet: Parameters<typeof startTestLab>[0] = {}) {
	t = await startTestLab({ modules: ['maintenance'], ...fleet });
	holder[key] = t.rt;
	return t;
}
afterEach(async () => {
	delete holder[key];
	await t?.stop();
	t = null;
});

async function call(
	handler: (e: RequestEvent) => Promise<Response> | Response,
	params: Record<string, string>,
	method = 'GET',
	body?: unknown
) {
	const res = await handler({
		params,
		request: new Request('http://localhost/api/x', {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	} as unknown as RequestEvent);
	return { status: res.status, body: await res.json() };
}

const until = async (ok: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error('Timed out waiting.');
		await new Promise((r) => setTimeout(r, 20));
	}
};

describe('the maintenance module', () => {
	it('turns print hours into a due task, fires maintenance.due once and resets when done', async () => {
		const t = await lab({ fleet: ['C12'] });
		const { info } = t.printer('C12');
		const m = t.rt.module('maintenance')!;
		// Defaults from the wiki at start; the AMS tasks once the P1S reports its AMS.
		await until(() => m.store.tasks(info.id).some((x) => x.kind === 'ams_desiccant'));
		const first = await call(overviewRoute, { id: info.id });
		const overview = first.body as MaintenanceOverview;
		expect(overview).toMatchObject({
			odometer: { totalHours: 0 },
			rack: null,
			canSetNozzle: true,
			releaseNotes: 'https://wiki.bambulab.com/en/p1/manual/p1p-firmware-release-history'
		});
		expect(overview.tasks.some((x) => x.kind === 'z_lead_screws')).toBe(true);

		// A task due after 0.01 print hours; the simulated print takes at least a minute of job time.
		const added = await call(addRoute, { id: info.id }, 'POST', {
			label: 'Wipe the bed',
			intervalHours: 0.01
		});
		expect(added.status).toBe(200);
		const taskId = added.body.task.id as string;

		const events: string[] = [];
		const off = t.rt.bus.on('maintenance.due', (d) => events.push(d.taskId));
		const due = t.nextEvent('maintenance.due', (d) => d.taskId === taskId);
		const { lab: l, printing } = t.rt;
		const profileId = l.createProfile({ name: 'Ana', color: 'pink' });
		const projectId = l.createProject({ profileId, title: 'Badge' });
		const jobId = l.createJob({ projectId });
		printing.attach(
			jobId,
			fakeSliced({ minutes: 1, grams: 3, printerModelId: 'C12' }),
			'b.gcode.3mf'
		);
		printing.send(jobId, { useAms: true, amsMapping: [0] });
		expect(await due).toMatchObject({
			printerId: info.id,
			printerName: info.name,
			label: 'Wipe the bed',
			kind: 'custom',
			by: 'hours'
		});
		expect(m.store.odometer(info.id).jobHours).toBeGreaterThan(0.01);
		// Checking again (hourly timer, another print) does not repeat it.
		m.check();
		expect(events.filter((id) => id === taskId)).toHaveLength(1);
		off();

		const done = await call(doneRoute, { id: info.id, taskId }, 'POST', { note: 'Clean' });
		expect(done.status).toBe(200);
		const task = (done.body.overview as MaintenanceOverview).tasks.find((x) => x.id === taskId)!;
		expect(task.due.state).toBe('ok');
		expect((done.body.overview as MaintenanceOverview).log[0]).toMatchObject({
			taskId,
			note: 'Clean'
		});

		const odo = await call(odometerRoute, { id: info.id }, 'PUT', { baselineHours: 250 });
		expect(odo.body.odometer.totalHours).toBeGreaterThan(250);
		expect((await call(overviewRoute, { id: 'missing' })).status).toBe(404);
	});

	it('logs a nozzle change and tells a single-nozzle printer', async () => {
		const t = await lab({ fleet: ['C12'] });
		const { info, sim } = t.printer('C12');
		const res = await call(nozzleRoute, { id: info.id }, 'POST', {
			diameter: 0.6,
			type: 'hardened_steel',
			send: true
		});
		expect(res.status).toBe(200);
		expect(res.body.entry).toMatchObject({
			kind: 'nozzle',
			label: 'Nozzle changed to 0.6 mm hardened steel'
		});
		expect(sim.state.nozzle_diameter).toBe('0.6');
		await until(() => t.rt.printers.get(info.id)?.snapshot?.nozzles[0]?.diameter === 0.6);
		expect(t.rt.printers.get(info.id)?.snapshot?.nozzles[0]?.type).toBe('hardened_steel');
		// Asking to send without a type is refused before anything is logged.
		const bad = await call(nozzleRoute, { id: info.id }, 'POST', { diameter: 0.4, send: true });
		expect(bad.status).toBe(400);
	});

	it('refuses set_accessories on dual-nozzle printers and shows the firmware offer', async () => {
		const t = await lab({ fleet: ['N6'] });
		const { info, sim } = t.printer('N6');
		const refused = await call(nozzleRoute, { id: info.id }, 'POST', {
			diameter: 0.4,
			type: 'stainless_steel',
			send: true
		});
		expect(refused).toMatchObject({ status: 409 });
		expect(refused.body.error).toMatch(/reads its nozzles itself/);
		const overview = (await call(overviewRoute, { id: info.id })).body as MaintenanceOverview;
		expect(overview.canSetNozzle).toBe(false);

		simMaintenance
			.controls!.find((c) => c.id === 'offer-update')!
			.run(sim, { version: '01.02.03.04' });
		await until(() => t.rt.printers.get(info.id)?.snapshot?.upgrade.available === true);
		expect(t.rt.printers.get(info.id)?.snapshot?.upgrade.version).toBe('01.02.03.04');
		simMaintenance.controls!.find((c) => c.id === 'clear-update')!.run(sim, {});
		await until(() => t.rt.printers.get(info.id)?.snapshot?.upgrade.available === false);
	});

	it('shows the H2C hotend rack', async () => {
		const t = await lab({ fleet: ['O1C2'] });
		const { info } = t.printer('O1C2');
		const overview = (await call(overviewRoute, { id: info.id })).body as MaintenanceOverview;
		expect(overview.rack?.nozzles.length).toBe(5);
		expect(overview.tasks.some((x) => x.kind === 'hotend_rack')).toBe(true);
	});
});
