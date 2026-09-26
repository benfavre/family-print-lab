import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestLab, type TestLab } from '../testing/harness';
import { bootRuntime } from '../runtime';
import { openDatabase } from '../db';
import { Lab } from '../lab';
import { EventBus } from '../events';
import { PrinterManager } from './manager';
import { createFleet, type Fleet } from './sim/fleet';
import { createSimulator } from './sim/core';
import { fakeSliced } from './sliced';
import { parseSsdp } from './discovery';

async function until(check: () => unknown, ms = 8000) {
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
async function lab(o: Parameters<typeof startTestLab>[0] = {}): Promise<TestLab> {
	const t = await startTestLab({ modules: [], ...o });
	cleanups.push(() => t.stop());
	return t;
}

/** A job with a sliced file for `model`, ready to send. */
function queuedJob(t: TestLab, model: string, grams = 12) {
	const { lab: l, printing } = t.rt;
	const profileId = l.createProfile({ name: 'Alex', color: 'blue' });
	const projectId = l.createProject({ profileId, title: 'Desk hook' });
	const spoolId = l.createSpool({
		material: 'PLA',
		colorHex: '#ff7a2f',
		totalGrams: 1000,
		remainingGrams: 500
	});
	const jobId = l.createJob({ projectId, spoolId });
	printing.attach(
		jobId,
		fakeSliced({ minutes: 1, grams, printerModelId: model }),
		'hook.gcode.3mf'
	);
	return { jobId, spoolId };
}
const job = (t: TestLab, id: string) => t.rt.lab.getJob(id)!;

describe('test lab with a simulated fleet', () => {
	it('boots two printers quickly and prints a job sliced for the P1S to Succeeded', async () => {
		const started = Date.now();
		const t = await lab({ fleet: ['N6', 'C12'] });
		expect(Date.now() - started).toBeLessThan(5000);
		expect(t.rt.printers.statuses().map((s) => [s.model, s.connected])).toEqual([
			['N6', true],
			['C12', true]
		]);
		const p1s = t.printer('C12');
		const { jobId, spoolId } = queuedJob(t, 'C12');
		const finished = t.nextEvent('print.finished', (e) => e.printerId === p1s.info.id);
		const task = t.rt.printing.send(jobId, {
			printerId: p1s.info.id,
			useAms: true,
			amsMapping: [0]
		});
		expect(task.id).toBeTruthy();
		const event = await finished;
		// The lab closed the job before modules hear about it (events.ts ordering).
		expect(event.jobId).toBe(jobId);
		expect(job(t, jobId)).toMatchObject({
			status: 'Succeeded',
			printerId: p1s.info.id,
			chargeGrams: 12
		});
		expect(job(t, jobId).dispatch).toMatchObject({
			printerId: p1s.info.id,
			plate: 1,
			amsMapping: [0]
		});
		expect(t.rt.lab.snapshot().spools.find((s) => s.id === spoolId)?.remainingGrams).toBe(488);
		// The simulated printer used the P1S's own report shape and URL form (file:///sdcard/).
		expect(p1s.sim.state.gcode_state).toBe('FINISH');
	});

	it('refuses a file sliced for another model, naming both', async () => {
		const t = await lab({ fleet: ['N6'] });
		const x2d = t.printer('N6');
		const { jobId } = queuedJob(t, 'C12');
		const check = t.rt.printing.check(jobId, {
			printerId: x2d.info.id,
			useAms: false,
			amsMapping: []
		});
		expect(check.blocking).toContain('This file was sliced for the P1S. This printer is an X2D.');
		expect(() => t.rt.printing.send(jobId, { useAms: false, amsMapping: [] })).toThrow(/P1S/);
	});

	it('closes a stopped print as Cancelled', async () => {
		const t = await lab({ fleet: ['N6'], speed: 1 });
		const x2d = t.printer('N6');
		const { jobId } = queuedJob(t, 'N6');
		const started = t.nextEvent('print.started');
		t.rt.printing.send(jobId, { useAms: true, amsMapping: [0] });
		await started;
		const cancelled = t.nextEvent('print.cancelled');
		await expect(t.rt.printers.require(x2d.info.id).control('stop')).resolves.toBe('confirmed');
		expect((await cancelled).jobId).toBe(jobId);
		expect(job(t, jobId)).toMatchObject({ status: 'Cancelled', chargeGrams: 0 });
	});

	it('runs pause and resume through the command layer per printer', async () => {
		const t = await lab({ fleet: ['N6', 'N1'], speed: 1 });
		const mini = t.rt.printers.require(t.printer('N1').info.id);
		t.fleet.printers[1].sim.start({ name: 'rocket', minutes: 30 });
		await until(() => mini.snapshot?.gcodeState === 'PREPARE');
		t.fleet.printers[1].sim.sim.state.gcode_state = 'RUNNING';
		t.fleet.printers[1].sim.report();
		await until(() => mini.snapshot?.gcodeState === 'RUNNING');
		const paused = t.nextEvent('print.paused');
		await mini.control('pause');
		expect(await paused).toMatchObject({ reason: 'user', task: 'rocket' });
		await mini.control('resume');
		await until(() => mini.snapshot?.gcodeState === 'RUNNING');
		// The other printer never noticed.
		expect(t.rt.printers.require(t.printer('N6').info.id).snapshot?.gcodeState).toBe('IDLE');
	});
});

describe('waking a printer before a send (beforeDispatch hooks)', () => {
	it('lets an offline printer be woken inside the send task, then prints', async () => {
		const t = await lab({ fleet: ['C12'] });
		const p1s = t.printer('C12');
		const entry = t.fleet.printers[0];
		const { jobId } = queuedJob(t, 'C12');
		await entry.sim.close();
		await until(() => !t.rt.printers.get(p1s.info.id)!.connected);
		const opts = { printerId: p1s.info.id, useAms: true, amsMapping: [0] };
		expect(t.rt.printing.check(jobId, opts).blocking).toContain('The printer is not connected.');
		// Waking only helps when something can wake it.
		expect(t.rt.printing.check(jobId, { ...opts, wake: true }).blocking).toContain(
			'The printer is not connected.'
		);
		const calls: string[] = [];
		const off = t.rt.hooks.beforeDispatch.add(async ({ printerId, signal }) => {
			calls.push(printerId);
			// "Switch the plug on": the printer comes back and reconnects.
			await entry.sim.listen(entry.port, '127.0.0.1', entry.ftpPort);
			while (!t.rt.printers.get(printerId)!.connected && !signal.aborted)
				await new Promise((r) => setTimeout(r, 50));
		});
		expect(t.rt.printing.check(jobId, { ...opts, wake: true }).blocking).toEqual([]);
		const finished = t.nextEvent('print.finished', undefined, 25_000);
		t.rt.printing.send(jobId, { ...opts, wake: true });
		await finished;
		expect(calls).toEqual([p1s.info.id]);
		expect(job(t, jobId).status).toBe('Succeeded');
		off();
	}, 40_000);
});

describe('printer registry', () => {
	it('imports the BAMBU_* printer once, and upserts PRINTLAB_PRINTERS on every boot', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-registry-'));
		cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
		const env = {
			DATABASE_URL: path.join(dir, 'test.db'),
			BACKUP_DIR: path.join(dir, 'backups'),
			LAB_AI: 'off',
			LEGACY_IMPORT: '/nonexistent',
			BAMBU_HOST: '127.0.0.1',
			BAMBU_PORT: '1',
			BAMBU_SERIAL: 'sim-env-0001',
			BAMBU_ACCESS_CODE: '12345678',
			BAMBU_TLS: 'off',
			PRINTLAB_PRINTERS: JSON.stringify([
				{
					name: 'Fleet one',
					model: 'C12',
					host: '127.0.0.1',
					port: 2,
					serial: 'SIM-P1S-0009',
					accessCode: '12345678',
					tls: false,
					simulated: true
				}
			])
		};
		const first = bootRuntime({ env, modules: [], log: () => {} });
		expect(first.printers.info().map((p) => [p.serial, p.name, p.model])).toEqual([
			['SIM-ENV-0001', 'Bambu Lab X2D', 'N6'],
			['SIM-P1S-0009', 'Fleet one', 'C12']
		]);
		const envId = first.printers.info()[0].id;
		first.printers.remove(envId);
		await first.close();
		const second = bootRuntime({
			env: {
				...env,
				PRINTLAB_PRINTERS: env.PRINTLAB_PRINTERS.replace('Fleet one', 'Fleet renamed')
			},
			modules: [],
			log: () => {}
		});
		// The env printer was removed in Settings and stays removed; the fleet row was updated, not added.
		expect(second.printers.info().map((p) => p.name)).toEqual(['Fleet renamed']);
		await second.close();
	});

	it('adds, tests, edits, switches off, reorders and removes printers', async () => {
		const t = await lab({ fleet: ['N6'] });
		const extra = createSimulator({
			model: 'C11',
			serial: 'SIM-P1P-0042',
			speed: 60,
			failRate: 0,
			log: () => {}
		});
		const port = await extra.listen(0);
		cleanups.push(() => extra.close());
		const details = {
			name: 'Garage P1P',
			model: 'C11',
			host: '127.0.0.1',
			port,
			ftpPort: extra.ftpPort,
			serial: 'SIM-P1P-0042',
			accessCode: '12345678',
			tls: false,
			simulated: true
		};
		const bad = await t.rt.printers.test({ ...details, accessCode: 'WRONG123' });
		expect(bad).toMatchObject({ ok: false });
		expect(bad.detail).toMatch(/access code/);
		const good = await t.rt.printers.test(details);
		expect(good).toMatchObject({ ok: true, model: 'C11', firmware: '01.08.02.00' });
		expect(good.detail).toMatch(/P1P/);

		const added = t.rt.printers.create(details);
		expect(added).toMatchObject({ name: 'Garage P1P', hasAccessCode: true, sortOrder: 1 });
		expect(JSON.stringify(t.rt.lab.snapshot().printers)).not.toContain('12345678');
		expect(() => t.rt.printers.create(details)).toThrow(/already saved/);
		await until(() => t.rt.printers.get(added.id)?.connected);

		const renamed = t.rt.printers.update(added.id, {
			version: added.version,
			name: 'Shed P1P',
			accessCode: ''
		});
		expect(renamed.name).toBe('Shed P1P');
		expect(() => t.rt.printers.update(added.id, { version: added.version, name: 'x' })).toThrow(
			/changed somewhere else/
		);
		const off = t.rt.printers.update(added.id, { version: renamed.version, enabled: false });
		expect(t.rt.printers.get(added.id)).toBeUndefined();
		expect(() => t.rt.printers.require(added.id)).toThrow(/switched off/);
		expect(t.rt.printers.statuses()[1]).toMatchObject({ enabled: false, connected: false });

		const x2d = t.printer('N6').info.id;
		t.rt.printers.reorder([added.id, x2d]);
		expect(t.rt.printers.info().map((p) => p.id)).toEqual([added.id, x2d]);
		// The first enabled printer is the primary one, whatever the order.
		expect(t.rt.printers.primary()?.id).toBe(x2d);
		t.rt.printers.update(added.id, { version: off.version, enabled: true });
		await until(() => t.rt.printers.get(added.id)?.connected);
		expect(t.rt.printers.primary()?.id).toBe(added.id);

		// Removing keeps the job history; its printer becomes "any".
		const profileId = t.rt.lab.createProfile({ name: 'Sam', color: 'green' });
		const projectId = t.rt.lab.createProject({ profileId, title: 'Box' });
		const jobId = t.rt.lab.createJob({ projectId, printerId: added.id });
		t.rt.printers.remove(added.id);
		expect(t.rt.lab.getJob(jobId)?.printerId).toBeNull();
		expect(() => t.rt.printers.require(added.id)).toThrow(/no longer exists/);
	});

	it('finds printers announcing themselves over SSDP', async () => {
		const probe = dgram.createSocket('udp4');
		const port = await new Promise<number>((r) =>
			probe.bind(0, '127.0.0.1', () => r(probe.address().port))
		);
		probe.close();
		const fleet: Fleet = await createFleet({
			printers: [
				{ model: 'N7', log: () => {} },
				{ model: 'N1', log: () => {} }
			],
			ssdpPort: port,
			ssdpIntervalMs: 150
		});
		cleanups.push(() => fleet.close());
		const t = await lab({ fleet: ['N1'] });
		const found = await t.rt.printers.discoverDetailed({ ms: 900, port });
		expect(found.warning).toBeUndefined();
		const bySerial = Object.fromEntries(found.printers.map((p) => [p.serial, p]));
		expect(bySerial['SIM-P2S-0001']).toMatchObject({
			model: 'N7',
			host: '127.0.0.1',
			lanOnly: true,
			known: false
		});
		// The A1 mini of the test lab has the same serial as the fleet's: it is already saved.
		expect(bySerial['SIM-A1MINI-0001']).toMatchObject({ model: 'N1', known: true });
	});

	it('parses SSDP defensively', () => {
		const sample = [
			'NOTIFY * HTTP/1.1',
			'Host: 239.255.255.250:1990',
			'Location: 10.13.1.30',
			'NT: urn:bambulab-com:device:3dprinter:1',
			'USN: 22E8BJ610801473',
			'DevModel.bambu.com: N7',
			'DevName.bambu.com: Workshop',
			'DevConnect.bambu.com: cloud',
			'DevVersion.bambu.com: 01.02.00.00',
			'',
			''
		].join('\r\n');
		expect(parseSsdp(sample)).toMatchObject({
			serial: '22E8BJ610801473',
			host: '10.13.1.30',
			model: 'N7',
			name: 'Workshop',
			lanOnly: false,
			firmware: '01.02.00.00'
		});
		expect(parseSsdp(sample.replace('10.13.1.30', 'evil.example'))).toBeNull();
		expect(parseSsdp(sample.replace('3dprinter', 'toaster'))).toBeNull();
		expect(parseSsdp(sample.replace('Workshop', 'x'.repeat(300)))).toBeNull();
		expect(parseSsdp('x'.repeat(3000))).toBeNull();
	});

	it('reports a printer offline only after it stays away', async () => {
		const db = openDatabase(':memory:');
		const bus = new EventBus(() => {});
		const l = new Lab(db, bus);
		const sim = createSimulator({ model: 'N1', speed: 1, failRate: 0, log: () => {} });
		const port = await sim.listen(0);
		const manager = new PrinterManager(db, l, bus, {
			env: {
				PRINTLAB_PRINTERS: JSON.stringify([
					{
						name: 'Mini',
						model: 'N1',
						host: '127.0.0.1',
						port,
						serial: sim.serial,
						accessCode: '12345678',
						tls: false,
						simulated: true
					}
				])
			},
			log: () => {},
			offlineAfterMs: 300
		});
		cleanups.push(() => manager.stop());
		const events: string[] = [];
		bus.onAny((e) => events.push(e.name));
		manager.start();
		await until(() => events.includes('printer.online'));
		await sim.close();
		await until(() => !manager.primary()!.connected);
		expect(events).not.toContain('printer.offline');
		await until(() => events.includes('printer.offline'), 3000);
	});
});

describe('printer details', () => {
	it('validates what people type', async () => {
		const { parse, printerInput } = await import('../validation');
		const base = {
			name: 'P1S',
			model: 'C12',
			host: '192.168.1.20',
			serial: '01p00a1b2c3',
			accessCode: 'ab12CD34'
		};
		expect(parse(printerInput, base)).toMatchObject({
			serial: '01P00A1B2C3',
			port: 8883,
			ftpPort: 990,
			tls: true
		});
		for (const host of ['printer.local', 'fe80::1', '[fe80::1]', '10.0.0.5'])
			expect(parse(printerInput, { ...base, host }).host).toBe(host);
		expect(() => parse(printerInput, { ...base, host: '999.1.1.1' })).toThrow(/IP address/);
		expect(() => parse(printerInput, { ...base, host: 'bad host!' })).toThrow(/IP address/);
		expect(() => parse(printerInput, { ...base, accessCode: 'short' })).toThrow(/8 letters/);
		expect(() => parse(printerInput, { ...base, serial: 'x' })).toThrow(/serial/);
		expect(() => parse(printerInput, { ...base, model: 'Z9' })).toThrow();
		expect(() => parse(printerInput, { ...base, port: 70000 })).toThrow();
	});
});
