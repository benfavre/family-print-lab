// The v2 remote parts with stand-ins: alerts, queue sharing, push events, "start next" and pictures.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { openDatabase } from '../db';
import { EventBus } from '../events';
import { Lab } from '../lab';
import { findFfmpeg } from '../modules/camera/ffmpeg';
import { emptySnapshot, type PrinterStatus } from '$lib/shared/printers/status';
import { controlMac, newPhoneKey, open, phoneKeys } from './phone';
import { fitForPhone, jpegSize, MAX_WIDTH } from './picture';
import { Remote, type CloudHost, type RemoteSettings } from './remote';

const status = (
	id: string,
	gcodeState: string,
	over: Partial<PrinterStatus> = {}
): PrinterStatus => ({
	configured: true,
	id,
	name: `Printer ${id}`,
	model: 'C12',
	modelName: 'P1S',
	enabled: true,
	connected: true,
	state: emptySnapshot({
		gcodeState,
		task: 'Dragon',
		percent: 40,
		remainingMinutes: 20,
		hms: [{ attr: 0x07002000, code: 0x00020001 }]
	}),
	...over
});

function setup(over: Partial<RemoteSettings> = {}, modules: Record<string, unknown> = {}) {
	const bus = new EventBus(() => {});
	const lab = new Lab(openDatabase(':memory:'));
	const host = Object.assign(new EventEmitter(), {
		statuses: () => [
			status('a', 'RUNNING'),
			status('b', 'IDLE', { connected: false }),
			status('c', 'IDLE', { enabled: false })
		],
		bus,
		module: (key: string) => modules[key] as never
	}) as unknown as CloudHost;
	const settings: RemoteSettings = {
		shareProgress: true,
		shareAlerts: false,
		shareQueue: false,
		snapshots: false,
		remoteControl: true,
		...over
	};
	const keys = phoneKeys(newPhoneKey());
	let changed = 0;
	const remote = new Remote(
		host,
		lab,
		() => settings,
		() => keys,
		() => true,
		() => changed++
	);
	return { bus, lab, remote, keys, settings, changed: () => changed };
}

describe('the phone’s view of the printers', () => {
	it('lists enabled printers with only what the phone shows', () => {
		const { remote } = setup();
		const list = remote.summaries()!;
		expect(list.map((p) => [p.id, p.state])).toEqual([
			['a', 'printing'],
			['b', 'offline']
		]);
		expect(list[0]).toEqual({
			id: 'a',
			name: 'Printer a',
			model: 'P1S',
			state: 'printing',
			title: 'Dragon',
			percent: 40,
			remainingMinutes: 20,
			layer: null,
			totalLayers: null,
			camera: false,
			event: null
		});
	});

	it('adds alerts only when shared, from the hms package when present', () => {
		expect(setup({ shareAlerts: true }).remote.summaries()![0].hms).toEqual([
			// Without the hms package the severity still comes from the code (0x0002…: serious).
			{ key: '0700200000020001', severity: 'serious', text: '' }
		]);
		const hms = {
			active: () => [{ key: 'k', severity: 'serious', text: 'Nozzle clog', kind: 'hms' }],
			describe: () => ({ severity: 'serious' })
		};
		const { remote, bus, changed } = setup({ shareAlerts: true }, { hms });
		expect(remote.summaries()![0].hms).toEqual([
			{ key: 'k', severity: 'serious', text: 'Nozzle clog' }
		]);
		// A serious alert becomes a push event.
		bus.emit('hms.raised', { printerId: 'a', printerName: 'A', hms: { attr: 1, code: 2 } });
		expect(remote.summaries()![0].event).toMatchObject({ kind: 'alert' });
		expect(changed()).toBe(1);
	});

	it('marks finished, failed, cancelled and paused prints as push events', () => {
		const { remote, bus } = setup();
		const ref = { printerId: 'a', printerName: 'A', jobId: null, task: 'Dragon' };
		bus.emit('print.paused', { ...ref, reason: 'user', stage: 16 });
		expect(remote.summaries()![0].event?.kind).toBe('paused');
		bus.emit('print.finished', { ...ref, minutes: 5 });
		expect(remote.summaries()![0].event?.kind).toBe('finished');
		expect(remote.summaries()![1].event).toBeNull();
	});

	it('shares nothing while status sharing is off', () => {
		const { remote } = setup({ shareProgress: false });
		expect(remote.summaries()).toBeNull();
		expect(remote.printersMessage('d')).toEqual({
			type: 'printers',
			printers: null,
			control: false,
			snapshots: false
		});
	});
});

describe('the queue on the phone', () => {
	const view = (plateClearNeeded = false) => ({
		items: [
			{
				id: 'q1',
				title: 'Dragon',
				printerId: null,
				status: 'waiting',
				minutes: 30,
				waitingFor: null
			},
			{
				id: 'q2',
				title: 'Boat',
				printerId: 'a',
				status: 'held',
				minutes: 10,
				waitingFor: 'Filament'
			},
			{ id: 'q0', title: 'Done', printerId: 'a', status: 'sent', minutes: 5, waitingFor: null }
		],
		printers: [{ printerId: 'a', plateClearNeeded }]
	});
	const queue = (plate = false) => {
		const calls: unknown[] = [];
		return {
			list: () => view(plate),
			// What Start next would send: the queue's own choice (q2 is held).
			startNextItem: () => (plate ? null : 'q1'),
			printer: (id: string, o: unknown) => calls.push([id, o]),
			calls
		};
	};

	it('is shared sealed, only when switched on', () => {
		expect(setup({}, { queue: queue() }).remote.queue()).toBeNull();
		const { remote, keys, bus } = setup({ shareQueue: true }, { queue: queue() });
		expect(remote.queue()!.map((i) => i.id)).toEqual(['q1', 'q2']);
		bus.emit('queue.held', { itemId: 'q2', jobId: 'j', printerId: 'a', reason: 'Filament' });
		const message = remote.queueMessage('d');
		expect(message.items).toBeUndefined();
		expect(message.event).toMatchObject({ kind: 'queue-held' });
		const items = JSON.parse(
			open(keys, Buffer.from(message.sealed!, 'base64'), 'queue|d').toString()
		);
		expect(items[0]).toEqual({
			id: 'q1',
			title: 'Dragon',
			printerId: null,
			status: 'waiting',
			minutes: 30,
			waitingFor: null
		});
	});

	it('starts the next queued print only when it is the one the phone saw and the plate is clear', async () => {
		const sign = (keys: ReturnType<typeof phoneKeys>, queueItemId: string) => {
			const c = {
				commandId: randomUUID(),
				printerId: 'a',
				action: 'dispatch' as const,
				at: Date.now(),
				queueItemId
			};
			return { ...c, mac: controlMac(keys, c) };
		};
		const q = queue();
		const { remote, keys, lab } = setup({ shareQueue: true }, { queue: q });
		expect(await remote.control(sign(keys, 'q2'))).toMatchObject({
			ok: false,
			error: 'The queue changed. Have another look before starting.'
		});
		expect(await remote.control(sign(keys, 'q1'))).toEqual({ ok: true });
		expect(q.calls).toEqual([['a', { startNext: true }]]);
		expect(lab.snapshot().activity[0].message).toMatch(
			/Started the next queued print on Printer a/
		);

		const blocked = setup({ shareQueue: true }, { queue: queue(true) });
		expect(await blocked.remote.control(sign(blocked.keys, 'q1'))).toMatchObject({
			ok: false,
			error: expect.stringMatching(/clear the plate/)
		});
	});
});

describe('pictures for the phone', () => {
	const ffmpeg = findFfmpeg();

	it('reads a JPEG’s size and passes small ones through', async () => {
		const tiny = Buffer.from(
			'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
			'base64'
		);
		expect(jpegSize(tiny)).toEqual({ width: 1, height: 1 });
		expect(await fitForPhone(tiny, null)).toBe(tiny);
		expect(jpegSize(Buffer.from('nope'))).toBeNull();
		await expect(fitForPhone(Buffer.from('nope'), null)).rejects.toThrow(/did not send a picture/);
	});

	it.skipIf(!ffmpeg)('scales big pictures down to 1280 px wide', async () => {
		const big = execFileSync(ffmpeg!, [
			'-hide_banner',
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'testsrc=size=1920x1080',
			'-frames:v',
			'1',
			'-f',
			'image2',
			'-c:v',
			'mjpeg',
			'pipe:1'
		]);
		expect(jpegSize(big)?.width).toBe(1920);
		await expect(fitForPhone(big, null)).rejects.toThrow(/ffmpeg is not installed/);
		const small = await fitForPhone(big, ffmpeg);
		expect(jpegSize(small)).toEqual({ width: MAX_WIDTH, height: 720 });
		expect(fs.existsSync(ffmpeg!)).toBe(true);
	});
});
