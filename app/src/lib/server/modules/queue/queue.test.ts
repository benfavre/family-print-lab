// The queue against simulated printers: jobs start one after another once the plate is confirmed
// clear, respect quiet hours, go to "any printer" that fits, and hold when the filament is wrong.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { queuePrinterState } from '../../db/schema';
import { startTestLab, type TestLab } from '../../testing/harness';
import { fakeSliced } from '../../printer/sliced';
import { defaultQueueSettings } from '$lib/shared/queue';
import { moduleSettings } from '../../module-settings';
import { Queue } from './service';
import { queueSettings } from './validation';
import type { ModelCode } from '$lib/shared/printers/models';

async function until(check: () => unknown, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error('Timed out waiting for condition');
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function lab(fleet: ModelCode[] = ['C12']) {
	const t = await startTestLab({ modules: ['queue'], fleet });
	cleanups.push(() => t.stop());
	return t;
}
const queueOf = (t: TestLab) => t.rt.module('queue') as Queue;

/** A queued job with a sliced file for `model`. */
function job(t: TestLab, model: string, title: string, type = 'PLA') {
	const { lab: l, printing } = t.rt;
	const profileId =
		l.snapshot().profiles[0]?.id ?? l.createProfile({ name: 'Alex', color: 'blue' });
	const projectId = l.createProject({ profileId, title });
	const jobId = l.createJob({ projectId });
	printing.attach(
		jobId,
		fakeSliced({
			minutes: 1,
			grams: 5,
			printerModelId: model,
			filaments: [{ type, color: '#000000', grams: 5 }]
		}),
		`${title}.gcode.3mf`
	);
	return jobId;
}
const status = (t: TestLab, jobId: string) => t.rt.lab.getJob(jobId)?.status;
const item = (t: TestLab, jobId: string) =>
	queueOf(t)
		.list()
		.items.find((i) => i.jobId === jobId);

describe('the print queue with simulated printers', () => {
	it('starts two jobs one after another, the second after the plate is confirmed clear', async () => {
		const t = await lab();
		const p1s = t.printer('C12').info.id;
		const q = queueOf(t);
		const first = job(t, 'C12', 'Rocket');
		const second = job(t, 'C12', 'Boat');
		const finished = t.nextEvent('print.finished', (e) => e.jobId === first, 20_000);
		q.add({ jobId: first, printerId: p1s });
		q.add({ jobId: second });
		await finished;
		expect(status(t, first)).toBe('Succeeded');
		// The plate is full now: the second waits for someone to say it is clear.
		await until(() => q.list().printers[0].plateClearNeeded);
		q.pass();
		expect(status(t, second)).toBe('Queued');
		expect(item(t, second)?.waitingFor).toBe(
			'Bambu Lab P1S: Waiting for someone to clear the plate.'
		);
		const done = t.nextEvent('print.finished', (e) => e.jobId === second, 20_000);
		const dispatched = t.nextEvent('queue.dispatched', (e) => e.jobId === second);
		q.printer(p1s, { plateCleared: true });
		expect(await dispatched).toMatchObject({ printerId: p1s });
		await done;
		expect(status(t, second)).toBe('Succeeded');
		// Finished items leave the queue.
		await until(() => q.list().items.length === 0);
	}, 45_000);

	it('sends three jobs to two printers, respecting quiet hours and the model each was sliced for', async () => {
		const t = await lab(['C12', 'N6']);
		const q = queueOf(t);
		const p1s = t.printer('C12').info.id;
		const x2d = t.printer('N6').info.id;
		// Quiet hours around now, every day.
		const hm = (d: Date) =>
			`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
		const start = hm(new Date(Date.now() - 3600_000));
		const end = hm(new Date(Date.now() + 3600_000));
		q.settings({
			...defaultQueueSettings(),
			quietHours: defaultQueueSettings().quietHours.map(() => ({ on: true, start, end }))
		});
		const a = job(t, 'N6', 'Vase');
		const b = job(t, 'C12', 'Hook');
		const c = job(t, 'N6', 'Lamp');
		for (const jobId of [a, b, c]) q.add({ jobId, printerId: null, requirePlateClear: true });
		q.pass();
		expect([a, b, c].map((j) => status(t, j))).toEqual(['Queued', 'Queued', 'Queued']);
		expect(q.list().printers.map((p) => p.blocked)).toEqual(['Quiet hours.', 'Quiet hours.']);
		expect(q.list().quietNow).toBe(true);

		// Quiet hours over: each printer takes the first job sliced for it.
		const aDone = t.nextEvent('print.finished', (e) => e.jobId === a, 20_000);
		const bDone = t.nextEvent('print.finished', (e) => e.jobId === b, 20_000);
		q.settings(defaultQueueSettings());
		const [ea, eb] = await Promise.all([aDone, bDone]);
		expect(ea.printerId).toBe(x2d);
		expect(eb.printerId).toBe(p1s);
		// c waits for the X2D's plate; the P1S cannot take an X2D file.
		await until(() => q.list().printers.every((p) => p.plateClearNeeded));
		q.printer(p1s, { plateCleared: true });
		q.pass();
		expect(status(t, c)).toBe('Queued');
		const cDone = t.nextEvent('print.finished', (e) => e.jobId === c, 20_000);
		q.printer(x2d, { plateCleared: true });
		expect((await cDone).printerId).toBe(x2d);
	}, 60_000);

	it('holds a job whose filament is not loaded, and lets it go once released and fixed', async () => {
		const t = await lab();
		const q = queueOf(t);
		const p1s = t.printer('C12').info.id;
		const tpu = job(t, 'C12', 'Tyre', 'TPU');
		const held = t.nextEvent('queue.held', (e) => e.jobId === tpu);
		q.add({ jobId: tpu, printerId: p1s });
		expect((await held).reason).toBe('Filament 1 (TPU) has no AMS slot.');
		expect(item(t, tpu)).toMatchObject({ status: 'held' });
		expect(status(t, tpu)).toBe('Queued');
		// Someone loads TPU into the first tray: the tray change makes the queue look again.
		const { sim } = t.printer('C12');
		const first = sim.trays().find((x) => x.unit)!;
		Object.assign(first.tray, { tray_type: 'TPU', tray_sub_brands: 'TPU for AMS' });
		const started = t.nextEvent('print.started', (e) => e.jobId === tpu, 20_000);
		sim.report();
		await started;
		expect(t.rt.lab.getJob(tpu)?.dispatch?.amsMapping).toEqual([first.global]);
	}, 30_000);

	it('says a refused send only once, however often the queue looks again', async () => {
		const t = await lab();
		const q = queueOf(t);
		const p1s = t.printer('C12').info.id;
		const jobId = job(t, 'C12', 'Ghost');
		// The sliced file went missing (a restore without files): the send check refuses it.
		fs.rmSync(t.rt.printing.file(t.rt.lab.getJob(jobId)!.sliced!.file));
		const held: string[] = [];
		const changes: string[] = [];
		t.rt.bus.on('queue.held', (e) => held.push(e.reason));
		t.rt.bus.on('queue.changed', (e) => changes.push(e.reason));
		q.add({ jobId, printerId: p1s, requirePlateClear: false });
		q.pass();
		q.pass();
		q.pass();
		expect(held).toEqual([
			'The sliced file is missing (restored from a backup?). Attach it again.'
		]);
		expect(changes.filter((r) => r === 'dispatcher')).toHaveLength(1);
		expect(item(t, jobId)).toMatchObject({
			status: 'held',
			reason: 'The sliced file is missing (restored from a backup?). Attach it again.'
		});
	});

	it('asks for the plate to be confirmed when a printer has a finished print on it', async () => {
		const t = await lab();
		const q = queueOf(t);
		const p1s = t.printer('C12').info.id;
		const { sim } = t.printer('C12');
		// A print ended while nobody was watching (the queue has no row for this printer yet).
		t.rt.db.delete(queuePrinterState).run();
		Object.assign(sim.state, { gcode_state: 'FINISH' });
		// Before its first report the queue saves nothing for it: what is on the plate is unknown.
		const real = t.rt.printers.get(p1s)!;
		let reported = false;
		const printer = new Proxy(real, {
			get: (target, key, receiver) =>
				key === 'status' && !reported
					? () => ({ ...real.status(), connected: false, state: null })
					: Reflect.get(target, key, receiver)
		});
		const cold = new Queue({
			...t.rt,
			printers: Object.assign(Object.create(t.rt.printers), {
				list: () => [printer],
				get: () => printer
			}),
			settings: moduleSettings(t.rt.db, 'queue', queueSettings, defaultQueueSettings()),
			log: () => {}
		});
		expect(cold.list().printers[0]).toMatchObject({
			plateClearNeeded: false,
			blocked: 'The printer is not connected.'
		});
		expect(t.rt.db.select().from(queuePrinterState).all()).toEqual([]);
		// Its first report says a print finished: the plate needs confirming.
		sim.report();
		await until(() => real.status().state?.gcodeState === 'FINISH');
		reported = true;
		expect(cold.list().printers[0].plateClearNeeded).toBe(true);
		expect(q.list().printers[0].plateClearNeeded).toBe(true);
		const jobId = job(t, 'C12', 'Frog');
		q.add({ jobId, printerId: p1s });
		q.pass();
		expect(item(t, jobId)?.status).toBe('waiting');
		expect(status(t, jobId)).toBe('Queued');
	});

	it('starts the next job only on Start next when auto start is off, and never twice at once', async () => {
		const t = await lab();
		const q = queueOf(t);
		const p1s = t.printer('C12').info.id;
		q.printer(p1s, { autoDispatch: false });
		const one = job(t, 'C12', 'Owl');
		const two = job(t, 'C12', 'Cat');
		q.add({ jobId: one, printerId: p1s, requirePlateClear: false });
		q.add({ jobId: two, printerId: p1s, requirePlateClear: false });
		q.pass();
		expect(item(t, one)?.status).toBe('waiting');
		expect(item(t, one)?.waitingFor).toBe('Starts queued jobs only when you press Start next.');
		const started = t.nextEvent('print.started', (e) => e.jobId === one, 20_000);
		expect(q.printer(p1s, { startNext: true }).started).toBe(item(t, one)?.id);
		expect(item(t, one)?.status).toBe('dispatching');
		// While it is being sent, nothing else goes to that printer.
		expect(() => q.printer(p1s, { startNext: true })).toThrow('A print is being sent to it.');
		await started;
		await until(() => item(t, one)?.status === 'sent');
		expect(q.nextFor(p1s)).toEqual({ jobId: two });
	}, 30_000);

	it('drops a queued item when its job is sent by hand, and reorders a column', async () => {
		const t = await lab();
		const q = queueOf(t);
		const p1s = t.printer('C12').info.id;
		q.printer(p1s, { paused: true });
		const one = job(t, 'C12', 'One');
		const two = job(t, 'C12', 'Two');
		const a = q.add({ jobId: one, printerId: p1s });
		const b = q.add({ jobId: two, printerId: null });
		q.reorder({ printerId: p1s, ids: [b.id, a.id] });
		expect(q.list().items.map((i) => [i.jobId, i.printerId, i.position])).toEqual([
			[two, p1s, 0],
			[one, p1s, 1]
		]);
		expect(() => q.reorder({ printerId: p1s, ids: ['missing'] })).toThrow(/changed meanwhile/);
		const started = t.nextEvent('print.started', (e) => e.jobId === one, 20_000);
		t.rt.printing.send(one, { printerId: p1s, useAms: true, amsMapping: [0] });
		await started;
		q.pass();
		expect(q.list().items.map((i) => i.jobId)).toEqual([two]);
		q.remove(b.id);
		expect(q.list().items).toEqual([]);
	}, 30_000);
});

it('holds a sliced nozzle mismatch until the simulator reports the matching nozzle', async () => {
	const t = await lab(['C12']);
	const p = t.printer('C12');
	const q = queueOf(t);
	const jobId = job(t, 'C12', 'Large nozzle');
	t.rt.printing.attach(
		jobId,
		fakeSliced({
			minutes: 1,
			grams: 1,
			printerModelId: 'C12',
			nozzleDiameters: [0.6],
			filamentMaps: [1]
		}),
		'large.gcode.3mf'
	);
	const filesBefore = [...p.sim.files.keys()];
	const held = t.nextEvent('queue.held', (e) => e.jobId === jobId);
	q.add({ jobId, printerId: p.info.id });
	expect((await held).reason).toContain('needs a 0.6 mm nozzle');
	expect(status(t, jobId)).toBe('Queued');
	expect([...p.sim.files.keys()]).toEqual(filesBefore);
	const started = t.nextEvent('print.started', (e) => e.jobId === jobId);
	p.sim.state.nozzle_diameter = '0.6';
	p.sim.report();
	await started;
	expect(status(t, jobId)).toBe('Printing');
}, 20_000);
