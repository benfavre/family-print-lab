import { afterEach, describe, expect, it } from 'vitest';
import { decode, encode, TYPE } from './mqtt';
import { BambuPrinter, summarize } from './bambu';
import { diffStatus } from './diff';
import type { PrinterStatus } from '$lib/shared/printers/status';
import { createSimulator, type Simulator } from './simulator';
import { fakeSliced } from './sliced';
import { openDatabase } from '../db';
import { Lab } from '../lab';
import { printers } from '../db/schema';

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

/** Print start/finish as the PrinterManager derives them from status changes (diff.ts). */
function follow(printer: BambuPrinter, on: (name: string, task: string) => void) {
	let prev: PrinterStatus | null = null;
	printer.on('update', () => {
		const next = printer.status();
		for (const e of diffStatus({ id: 'p1', name: 'X2D' }, prev, next, () => null))
			if (e.name.startsWith('print.') && e.name !== 'print.layer')
				on(e.name, (e.data as { task: string }).task);
		prev = structuredClone(next);
	});
}

async function connect(options: { speed?: number; code?: string } = {}) {
	const sim: Simulator = createSimulator({
		speed: options.speed ?? 600,
		failRate: 0,
		log: () => {}
	});
	const port = await sim.listen(0);
	const printer = new BambuPrinter({
		id: 'p1',
		model: 'N6',
		host: '127.0.0.1',
		port,
		ftpPort: sim.ftpPort,
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

describe('MQTT QoS 1 and retain', () => {
	it('encodes and decodes packet ids, QoS, retain and PUBACK', () => {
		const bytes = Buffer.concat([
			encode.publish('a/b', '{"x":1}', { qos: 1, retain: true, id: 513 }),
			encode.puback(513)
		]);
		const { packets } = decode(bytes);
		expect(packets[0]).toMatchObject({
			type: TYPE.PUBLISH,
			topic: 'a/b',
			qos: 1,
			retain: true,
			id: 513
		});
		expect(packets[0].payload!.toString()).toBe('{"x":1}');
		expect(packets[1]).toMatchObject({ type: TYPE.PUBACK, id: 513 });
		expect(() =>
			decode(Buffer.concat([Buffer.from([0x30]), Buffer.from([0xff, 0xff, 0xff, 0x7f])]))
		).toThrow(/too large/);
	});

	it('resolves a QoS 1 publish on PUBACK and rejects it when the connection drops', async () => {
		const { printer } = await connect();
		await until(() => printer.status().connected && printer.status().state);
		// Pause is sent with QoS 1; the simulator acknowledges and answers.
		printer.snapshot!.gcodeState = 'RUNNING';
		await expect(printer.send('print.pause', {})).rejects.toThrow(/running print/);
		const sent: number[] = [];
		const client = (printer as unknown as { client: import('./mqtt').MqttClient }).client;
		await client.publish('device/x/request', '{}', { qos: 1 }).then(() => sent.push(1));
		expect(sent).toEqual([1]);
	});
});

describe('typed commands against the simulator', () => {
	it('uses decimal sequence ids in 20000–29999 and matches replies', async () => {
		const { printer } = await connect();
		await until(() => printer.status().connected && printer.versions.length);
		const out = await printer.send('info.get_version', {});
		expect(out.outcome).toBe('confirmed');
		expect(out.reply?.module).toBeTruthy();
		const seq = Number((printer as unknown as { sequence: number }).sequence);
		expect(seq).toBeGreaterThanOrEqual(20000);
		expect(seq).toBeLessThanOrEqual(29999);
		await expect(printer.send('print.nope' as 'print.stop', {})).rejects.toMatchObject({
			status: 400
		});
		await expect(printer.send('print.gcode_line', { lines: [] })).rejects.toMatchObject({
			status: 400
		});
	});

	it('refuses commands while Developer Mode is off, and says so', async () => {
		const { sim, printer } = await connect();
		await until(() => printer.status().connected && printer.status().state);
		sim.sim.state.fun = '20000000';
		sim.report();
		await until(() => printer.status().state?.developerMode === false);
		await expect(printer.control('stop')).rejects.toThrow(/Developer Mode is off/);
		expect(printer.status().warning).toMatch(/Developer Mode/);
	});
});

describe('reconnecting', () => {
	it('keeps the merged report and does not ask a delta printer for everything again', async () => {
		const { sim, printer } = await connect();
		const pushalls: string[] = [];
		const send = printer.send.bind(printer);
		printer.send = ((name, params, o) => {
			if (name === 'pushing.pushall') pushalls.push(name);
			return send(name, params, o);
		}) as typeof printer.send;
		await until(() => printer.status().connected && printer.snapshot);
		const port = printer.config.port!;
		await sim.close();
		await until(() => !printer.connected);
		await sim.listen(port, '127.0.0.1', sim.ftpPort);
		await until(() => printer.connected, 8000);
		// Once on the first connect only: the X2D sends deltas, so pushall at most every 5 minutes
		// (OpenBambuAPI mqtt.md).
		expect(pushalls).toEqual(['pushing.pushall']);
		expect(printer.snapshot?.gcodeState).toBe('IDLE');
	}, 12_000);
});

describe('diagnostics', () => {
	it('exports the raw report without serials, addresses or cloud ids', async () => {
		const { sim, printer } = await connect();
		await until(() => printer.status().connected && printer.versions.length);
		Object.assign(sim.sim.state, {
			model_id: 'US1fccd3bfcb9084',
			job_id: 904240393,
			net: { info: [{ ip: 889301184, mask: 16777215 }] },
			ipcam: { ipcam_dev: '1', rtsp_url: 'rtsps://192.168.1.5/streaming/live/1' },
			// Should a report ever carry the access code (a URL with credentials), it stays out too.
			upload: { url: `ftps://bblp:${sim.accessCode}@printer/` },
			upgrade_state: { sn: sim.serial, new_version_state: 2 }
		});
		sim.report(true);
		await until(() => printer.snapshot?.camera.rtspUrl);
		const raw = printer.rawReport();
		const text = JSON.stringify(raw);
		expect(raw.model).toBe('N6');
		expect(text).not.toContain(sim.serial);
		expect(text).not.toContain('192.168.1.5');
		expect(text).not.toContain('US1fccd3bfcb9084');
		expect(text).not.toContain('889301184');
		expect(text).not.toContain('904240393');
		expect(text).not.toContain(sim.accessCode);
		expect(raw.get_version.module).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'ota', sn: '**REDACTED**' })])
		);
		// The browser never sees the printer's own address in the camera URL either.
		expect(printer.status().state?.camera.rtspUrl).toBe('rtsps://printer/streaming/live/1');
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
		expect(s.ams[0].trays[0]).toMatchObject({
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
		follow(printer, (name, task) => events.push([name, task]));
		await until(() => printer.status().state?.gcodeState === 'IDLE');
		expect(printer.status()).toMatchObject({ connected: true, simulated: true });
		sim.start({ name: 'part', minutes: 2, slot: 2, grams: 100 });
		await until(() => events.length === 2, 10_000);
		expect(events).toEqual([
			['print.started', 'part'],
			['print.finished', 'part']
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
		lab.db
			.insert(printers)
			.values({
				id: 'p1',
				name: 'X2D',
				model: 'N6',
				host: '127.0.0.1',
				serial: sim.serial,
				accessCode: '12345678'
			})
			.run();
		follow(printer, (name, task) => {
			if (name === 'print.started') lab.linkStartedTask('p1', task);
			if (name === 'print.finished') lab.closePrinterTask('p1', task, 'succeeded');
		});
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

describe('sending prints', () => {
	it('uploads a sliced file, starts it with the AMS mapping, then pauses, resumes and stops it', async () => {
		const { sim, printer } = await connect({ speed: 1 });
		await until(() => printer.status().connected && printer.status().state);
		const file = fakeSliced({ minutes: 30, grams: 12, layers: 90 });
		const seen: number[] = [];
		await printer.upload('dock.gcode.3mf', file, (f) => seen.push(f));
		expect(sim.files.get('dock.gcode.3mf')?.data.length).toBe(file.length);
		expect(seen.at(-1)).toBe(1);

		await expect(
			printer.startPrint({
				file: 'dock.gcode.3mf',
				plate: 1,
				title: 'Desk cable dock',
				useAms: true,
				amsMapping: [2]
			})
		).resolves.toBe('confirmed');
		await until(() => printer.status().state?.task === 'Desk cable dock');
		expect(sim.sim.state.total_layer_num).toBe(90);
		expect(sim.sim.state.ams.tray_now).toBe('2');
		await expect(
			printer.startPrint({
				file: 'dock.gcode.3mf',
				plate: 1,
				title: 'x',
				useAms: false,
				amsMapping: []
			})
		).rejects.toThrow(/busy/);

		// Still preparing: the printer would ignore a pause, so the app says so instead.
		sim.sim.state.gcode_state = 'PREPARE';
		sim.report();
		await until(() => printer.status().state?.gcodeState === 'PREPARE');
		await expect(printer.control('pause')).rejects.toThrow(/preparing/);

		sim.sim.state.gcode_state = 'RUNNING';
		sim.report();
		await until(() => printer.status().state?.gcodeState === 'RUNNING');
		await printer.control('pause');
		await until(() => printer.status().state?.gcodeState === 'PAUSE');
		await printer.control('resume');
		await until(() => printer.status().state?.gcodeState === 'RUNNING');
		await printer.control('stop');
		await until(() => !printer.status().printing);
	});

	it('passes on the printer refusing a file sliced for another model or a missing file', async () => {
		const { printer } = await connect();
		await until(() => printer.status().connected && printer.status().state);
		await printer.upload(
			'p1s.gcode.3mf',
			fakeSliced({ minutes: 5, grams: 2, printerModelId: 'C12' })
		);
		await expect(
			printer.startPrint({
				file: 'p1s.gcode.3mf',
				plate: 1,
				title: 'x',
				useAms: false,
				amsMapping: []
			})
		).rejects.toThrow(/another printer/);
		await expect(
			printer.startPrint({
				file: 'nope.gcode.3mf',
				plate: 1,
				title: 'x',
				useAms: false,
				amsMapping: []
			})
		).rejects.toThrow(/not found/);
	});
});
