import { afterEach, describe, expect, it } from 'vitest';
import { decode, encode, TYPE } from './mqtt';
import { BambuPrinter, summarize } from './bambu';
import { createSimulator, type Simulator } from './simulator';
import { openDatabase } from '../db';
import { Lab } from '../lab';

async function until(check: () => unknown, ms = 5000) {
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

async function connect(options: { speed?: number; code?: string } = {}) {
	const sim: Simulator = createSimulator({
		speed: options.speed ?? 600,
		failRate: 0,
		log: () => {}
	});
	const port = await sim.listen(0);
	const printer = new BambuPrinter({
		host: '127.0.0.1',
		port,
		serial: sim.serial,
		accessCode: options.code ?? sim.accessCode,
		useTls: false,
		simulated: true
	});
	cleanups.push(
		() => sim.close(),
		() => printer.stop()
	);
	return { sim, printer: printer.start() };
}

describe('MQTT codec', () => {
	it('survives arbitrary chunking', () => {
		const bytes = Buffer.concat([
			encode.connect({ clientId: 'c', username: 'bblp', password: 'pw' }),
			encode.publish('t/x', 'y'.repeat(300)),
			encode.subscribe(7, 'a/b')
		]);
		for (const cut of [1, 2, 5, 40, 200, bytes.length - 1]) {
			const first = decode(bytes.subarray(0, cut));
			const second = decode(Buffer.concat([first.rest, bytes.subarray(cut)]));
			const packets = [...first.packets, ...second.packets];
			expect(packets.map((p) => p.type)).toEqual([TYPE.CONNECT, TYPE.PUBLISH, TYPE.SUBSCRIBE]);
			expect(packets[0].password).toBe('pw');
			expect(packets[1].payload!.toString()).toBe('y'.repeat(300));
		}
	});
});

describe('report parsing', () => {
	it('turns raw reports into a typed snapshot and tolerates missing fields', () => {
		const s = summarize({
			gcode_state: 'RUNNING',
			mc_percent: 42,
			layer_num: '80',
			subtask_name: 'dock',
			ams: {
				tray_now: '5',
				ams: [
					{ id: '1', tray: [{ id: '1', tray_type: 'PETG', tray_color: '00AE42FF', remain: -1 }] }
				]
			}
		});
		expect(s).toMatchObject({ gcodeState: 'RUNNING', percent: 42, layer: 80, task: 'dock' });
		expect(s.ams[0].trays[0]).toEqual({
			slot: '1',
			active: true,
			type: 'PETG',
			name: '',
			color: '#00ae42',
			remain: null
		});
		expect(summarize({}).gcodeState).toBe('UNKNOWN');
	});
});

describe('printer link against the simulator', () => {
	it('connects, follows a whole print and reports start and finish', async () => {
		const { sim, printer } = await connect();
		const events: unknown[] = [];
		printer.on('started', (e) => events.push(['started', e.task]));
		printer.on('finished', (e) => events.push(['finished', e.task, e.ok]));
		await until(() => printer.status().state?.gcodeState === 'IDLE');
		expect(printer.status()).toMatchObject({ connected: true, simulated: true });
		sim.start({ name: 'part', minutes: 2, slot: 2, grams: 100 });
		await until(() => events.length === 2, 10_000);
		expect(events).toEqual([
			['started', 'part'],
			['finished', 'part', true]
		]);
		expect(printer.status().state?.ams[0].trays[2].remain).toBeLessThan(92);
	});

	it('reports a rejected access code instead of retrying silently', async () => {
		const { printer } = await connect({ code: 'wrong' });
		await until(() => printer.status().error);
		expect(printer.status().error).toMatch(/access code/);
		expect(printer.status().connected).toBe(false);
	});

	it('drives the workspace: links the running job, then closes it and charges filament', async () => {
		const { sim, printer } = await connect();
		const lab = new Lab(openDatabase(':memory:'));
		printer.on('started', ({ task }) => lab.linkStartedTask(task));
		printer.on('finished', ({ task, ok }) => lab.closePrinterTask(task, ok));
		const profileId = lab.createProfile({ name: 'Alex', color: 'blue' });
		const projectId = lab.createProject({ profileId, title: 'Dock' });
		const spoolId = lab.createSpool({
			material: 'PLA',
			colorHex: '#ff7a2f',
			totalGrams: 1000,
			remainingGrams: 500
		});
		const jobId = lab.createJob({ projectId, spoolId, grams: 60 });
		lab.transitionJob(jobId, { to: 'Printing' });
		await until(() => printer.status().connected);
		sim.start({ name: 'dock_v01', minutes: 2 });
		await until(() => lab.snapshot().jobs[0].status === 'Succeeded', 10_000);
		const ws = lab.snapshot();
		expect(ws.jobs[0]).toMatchObject({ printerTask: 'dock_v01', chargeGrams: 60 });
		expect(ws.spools[0].remainingGrams).toBe(440);
		expect(ws.projects[0].status).toBe('Done');
	});
});
