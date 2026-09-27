import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
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

	it('prints from the external spool on a P1P without an AMS, whatever the tick box says', async () => {
		const t = await lab({ fleet: ['C11'] });
		const p1p = t.printer('C11');
		const { jobId } = queuedJob(t, 'C11');
		const finished = t.nextEvent('print.finished', (e) => e.printerId === p1p.info.id);
		// The send panel ticks "Feed from the AMS" when any tray is loaded, the external spool included;
		// the simulator refuses use_ams on a printer with no AMS, as Bambu Studio never sends it. (The
		// fixture's external spool holds PETG and the job is PLA, hence force.)
		t.rt.printing.send(jobId, {
			printerId: p1p.info.id,
			useAms: true,
			amsMapping: [255],
			force: true
		});
		await finished;
		expect(job(t, jobId).status).toBe('Succeeded');
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

	it('does not announce a print as started again when it reconnects mid-print', async () => {
		const t = await lab({ fleet: ['N6'], speed: 1 });
		const x2d = t.printer('N6');
		const { jobId } = queuedJob(t, 'N6');
		const started = t.nextEvent('print.started');
		t.rt.printing.send(jobId, { useAms: true, amsMapping: [0] });
		expect((await started).jobId).toBe(jobId);
		// Switched off and on in Settings: a fresh connection whose first report is mid-print.
		const version = () => t.rt.printers.info().find((p) => p.id === x2d.info.id)!.version;
		t.rt.printers.update(x2d.info.id, { enabled: false, version: version() });
		t.rt.printers.update(x2d.info.id, { enabled: true, version: version() });
		await until(() => t.rt.printers.get(x2d.info.id)?.status().printing);
		expect(t.rt.bus.recent().filter((e) => e.name === 'print.started')).toHaveLength(1);
		// Still linked: stopping it closes the job.
		const cancelled = t.nextEvent('print.cancelled');
		await t.rt.printers.require(x2d.info.id).control('stop');
		expect((await cancelled).jobId).toBe(jobId);
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

	it('checks the connection again after the hooks, and uploads nothing when still offline', async () => {
		const t = await lab({ fleet: ['C12'] });
		const p1s = t.printer('C12');
		const entry = t.fleet.printers[0];
		const { jobId } = queuedJob(t, 'C12');
		await entry.sim.close();
		await until(() => !t.rt.printers.get(p1s.info.id)!.connected);
		// A plug that never brings the printer back.
		const off = t.rt.hooks.beforeDispatch.add(async () => {});
		const task = t.rt.printing.send(jobId, {
			printerId: p1s.info.id,
			useAms: true,
			amsMapping: [0],
			wake: true
		});
		const info = () => t.rt.tasks.list().find((x) => x.id === task.id)!;
		await until(() => info().status !== 'running');
		expect(info().status).toBe('failed');
		expect(info().error).toBe('The printer is not connected.');
		expect(job(t, jobId).status).toBe('Queued');
		off();
	});
});

describe('sending one job', () => {
	it('refuses to send the same job to a second printer while the first send runs', async () => {
		const t = await lab({ fleet: ['C12', 'C11'] });
		const { jobId } = queuedJob(t, 'C12');
		const opts = { useAms: true, amsMapping: [0] };
		const first = t.printer('C12').info.id;
		const second = t.printer('C11').info.id;
		t.rt.printing.send(jobId, { ...opts, printerId: first });
		expect(t.rt.printing.check(jobId, { ...opts, printerId: second }).blocking).toContain(
			'This job is being sent right now.'
		);
	});
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
				{ model: 'N1', log: () => {} },
				{ model: 'BL-P001', log: () => {} }
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
		// Announced as "3DPrinter-X1-Carbon", found as the X1 Carbon.
		expect(Object.values(bySerial).find((p) => p.model === 'BL-P001')).toBeTruthy();
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
		// X1-series printers announce a name (Bambu Studio DevConfigUtil.h _parse_printer_type).
		expect(
			parseSsdp(sample.replace('DevModel.bambu.com: N7', 'DevModel.bambu.com: 3DPrinter-X1-Carbon'))
				?.model
		).toBe('BL-P001');
		expect(
			parseSsdp(sample.replace('DevModel.bambu.com: N7', 'DevModel.bambu.com: 3DPrinter-X1'))?.model
		).toBe('BL-P002');
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

describe('printer certificates and access codes', () => {
	it('sends the saved access code only to the same serial, and keeps the pin when the address changes', async () => {
		const db = openDatabase(':memory:');
		const bus = new EventBus();
		const manager = new PrinterManager(db, new Lab(db, bus), bus, { env: {}, log: () => {} });
		cleanups.push(() => manager.stop());
		const saved = manager.create({
			name: 'P1S',
			model: 'C12',
			host: '127.0.0.1',
			port: 1,
			serial: 'SIM-PIN-0001',
			accessCode: '12345678',
			enabled: false
		});
		await expect(
			manager.test({
				id: saved.id,
				name: 'P1S',
				model: 'C12',
				host: '10.0.0.66',
				serial: 'OTHER-0001'
			})
		).rejects.toThrow(/access code/);
		const { printers } = await import('../db/schema');
		const { eq } = await import('drizzle-orm');
		const pin = () => db.select().from(printers).where(eq(printers.id, saved.id)).get()!.tlsPin;
		db.update(printers)
			.set({ tlsPin: 'ab'.repeat(32) })
			.run();
		// DHCP gave it a new address: same printer, same certificate.
		const moved = manager.update(saved.id, { version: saved.version, host: '127.0.0.2' });
		expect(pin()).toBe('ab'.repeat(32));
		// Another printer: its certificate is trusted afresh (and it needs its own access code).
		expect(() =>
			manager.update(saved.id, { version: moved.version, serial: 'SIM-PIN-0002' })
		).toThrow(/access code/);
		manager.update(saved.id, {
			version: moved.version,
			serial: 'SIM-PIN-0002',
			accessCode: '87654321'
		});
		expect(pin()).toBeNull();
	});

	it('never sends the saved access code over a connection without the certificate check', async () => {
		const db = openDatabase(':memory:');
		const bus = new EventBus();
		const manager = new PrinterManager(db, new Lab(db, bus), bus, { env: {}, log: () => {} });
		cleanups.push(() => manager.stop());
		const saved = manager.create({
			name: 'P1S',
			model: 'C12',
			host: '127.0.0.1',
			port: 1,
			serial: 'SIM-CODE-0001',
			accessCode: 'SECRET12',
			enabled: false
		});
		const same = { id: saved.id, name: 'P1S', model: 'C12', serial: 'SIM-CODE-0001', port: 1 };
		// Plain MQTT or a "simulated" peer skip the certificate check: the code would go to anyone.
		for (const over of [
			{ host: '127.0.0.1', tls: false },
			{ host: '127.0.0.1', simulated: true },
			{ host: '10.0.0.66', tls: false },
			// A new address with nothing pinned would be trusted on first use.
			{ host: '10.0.0.66' }
		])
			await expect(manager.test({ ...same, ...over })).rejects.toThrow(/access code/);
		for (const patch of [{ tls: false }, { simulated: true }, { host: '10.0.0.66' }])
			expect(() => manager.update(saved.id, { version: saved.version, ...patch })).toThrow(
				/access code/
			);
		// A local peer closes before TLS completes, so the connection failure is deterministic.
		const peer = net.createServer((socket) => socket.destroy());
		await new Promise<void>((resolve) => peer.listen(0, '127.0.0.2', resolve));
		cleanups.push(() => new Promise<void>((resolve) => peer.close(() => resolve())));
		const port = (peer.address() as net.AddressInfo).port;
		// With the code typed in, changing the address is fine.
		const edited = manager.update(saved.id, {
			version: saved.version,
			host: '127.0.0.2',
			port,
			accessCode: 'NEWCODE1'
		});
		expect(edited.host).toBe('127.0.0.2');
		// The same saved connection can still be tested without typing the code (it fails to connect).
		await expect(manager.test({ ...same, host: '127.0.0.2', port })).resolves.toMatchObject({
			ok: false
		});
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

describe('feeder safety at dispatch', () => {
	it('sends a single-nozzle P1S file whose filament_maps names extruder 1', async () => {
		const t = await lab({ fleet: ['C12'] });
		const { jobId } = queuedJob(t, 'C12');
		t.rt.printing.attach(
			jobId,
			fakeSliced({ minutes: 1, grams: 1, printerModelId: 'C12', filamentMaps: [1] }),
			'single.gcode.3mf'
		);
		const p = t.printer('C12');
		const opts = { printerId: p.info.id, useAms: true, amsMapping: [0] };
		expect(t.rt.printing.check(jobId, opts)).toEqual({ blocking: [], warnings: [] });
		const task = t.rt.printing.send(jobId, opts);
		await until(() => t.rt.tasks.get(task.id).status !== 'running');
		expect(t.rt.tasks.get(task.id).status).toBe('done');
		expect(job(t, jobId).dispatch?.amsMapping).toEqual([0]);
	});

	it.each(['PLA', ''])(
		'blocks a known wrong-side external spool even with a material override (loaded type=%s)',
		async (type) => {
			const t = await lab({ fleet: ['N6'] });
			const { jobId } = queuedJob(t, 'N6');
			t.rt.printing.attach(
				jobId,
				fakeSliced({ minutes: 1, grams: 1, printerModelId: 'N6', filamentMaps: [1] }),
				'left.gcode.3mf'
			);
			const { info, sim } = t.printer('N6');
			sim.trays().find((x) => x.global === 255)!.tray.tray_type = type;
			sim.report();
			await until(
				() =>
					t.rt.printers.require(info.id).snapshot?.externalSpools.find((s) => s.global === 255)
						?.type === type
			);
			const filesBefore = [...sim.files.keys()];
			const opts = { printerId: info.id, useAms: true, amsMapping: [255], force: true };
			expect(t.rt.printing.check(jobId, opts).blocking).toContain(
				'Filament 1 uses the left nozzle, but slot Ext R feeds the other nozzle.'
			);
			expect(() => t.rt.printing.send(jobId, opts)).toThrow(/left nozzle/);
			expect([...sim.files.keys()]).toEqual(filesBefore);
			expect(job(t, jobId).status).toBe('Queued');
		}
	);

	it.each([
		{ type: 'PETG', force: false, error: /holds PETG/ },
		{ type: '', force: false, error: /has no AMS slot/ },
		{ type: 'PETG', force: true, error: null }
	])(
		'checks freshly reported material after wake (type=$type, force=$force)',
		async ({ type, force, error }) => {
			const t = await lab({ fleet: ['C12'] });
			const p = t.printer('C12');
			const entry = t.fleet.printers[0];
			const { jobId } = queuedJob(t, 'C12');
			const filesBefore = [...entry.sim.files.keys()];
			await entry.sim.close();
			await until(() => !t.rt.printers.get(p.info.id)!.connected);
			const opts = { printerId: p.info.id, useAms: true, amsMapping: [0], wake: true, force };
			const off = t.rt.hooks.beforeDispatch.add(async () => {
				const tray = p.sim.trays().find((x) => x.global === 0)!;
				tray.tray.tray_type = type;
				await entry.sim.listen(entry.port, '127.0.0.1', entry.ftpPort);
				await until(() => {
					const printer = t.rt.printers.require(p.info.id);
					return (
						printer.connected &&
						printer.snapshot?.ams.flatMap((u) => u.trays).find((s) => s.global === 0)?.type === type
					);
				});
			});
			try {
				expect(t.rt.printing.check(jobId, opts).warnings).toEqual([]);
				const task = t.rt.printing.send(jobId, opts);
				const info = () => t.rt.tasks.list().find((x) => x.id === task.id)!;
				await until(() => info().status !== 'running', 20_000);
				if (error) {
					expect(info().status).toBe('failed');
					expect(info().error).toMatch(error);
					expect([...entry.sim.files.keys()]).toEqual(filesBefore);
					expect(job(t, jobId).status).toBe('Queued');
				} else {
					expect(info().status).toBe('done');
					expect(entry.sim.files.size).toBe(filesBefore.length + 1);
				}
			} finally {
				off();
			}
		},
		30_000
	);
});
