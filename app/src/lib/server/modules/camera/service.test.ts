// Camera sessions (sharing, snapshot caching, stopping after the last viewer), how the camera path is
// chosen for each printer, and the media helpers.
import { describe, expect, it, vi } from 'vitest';
import { CameraSession } from './session';
import { CAMERA_MESSAGES, planCamera } from './service';
import { limiter, toMedia } from './media';
import type { CameraSource, FrameSink } from './source';
import { emptySnapshot, type PrinterSnapshot } from '$lib/shared/printers/status';
import { PRINTER_MODELS, type CameraProtocol, type ModelCode } from '$lib/shared/printers/models';
import type { BambuPrinter } from '$lib/server/printer/bambu';

function fakeSource() {
	let sink: FrameSink | null = null;
	const source: CameraSource & { starts: number; stops: number; send(b: Buffer): void } = {
		starts: 0,
		stops: 0,
		start(s) {
			sink = s;
			this.starts++;
		},
		stop() {
			sink = null;
			this.stops++;
		},
		send(b) {
			sink?.frame(b);
		}
	};
	return source;
}

describe('camera sessions', () => {
	it('shares one source between viewers and stops it a while after the last one leaves', () => {
		vi.useFakeTimers();
		try {
			const src = fakeSource();
			const session = new CameraSession(src, 'k', { lingerMs: 1000 });
			const a: number[] = [];
			const b: number[] = [];
			const offA = session.subscribe((f) => a.push(f[0]));
			const offB = session.subscribe((f) => b.push(f[0]));
			expect(src.starts).toBe(1);
			src.send(Buffer.from([1]));
			offA();
			src.send(Buffer.from([2]));
			expect(a).toEqual([1]);
			expect(b).toEqual([1, 2]);
			offB();
			vi.advanceTimersByTime(900);
			expect(src.stops).toBe(0);
			// Back before the linger ends: same stream, and the fresh frame right away.
			const c: number[] = [];
			const offC = session.subscribe((f) => c.push(f[0]));
			expect(c).toEqual([2]);
			offC();
			vi.advanceTimersByTime(1000);
			expect(src.stops).toBe(1);
			expect(session.active).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('answers snapshots from the newest frame while fresh, else waits for the next one', async () => {
		const src = fakeSource();
		const session = new CameraSession(src, 'k', { lingerMs: 50 });
		const first = session.snapshot({ maxAgeMs: 2000 });
		expect(src.starts).toBe(1);
		src.send(Buffer.from([7]));
		expect([...(await first)]).toEqual([7]);
		// Cached: no new frame needed.
		expect([...(await session.snapshot({ maxAgeMs: 2000 }))]).toEqual([7]);
		// Too old for this caller: waits.
		const later = session.snapshot({ maxAgeMs: -1 });
		src.send(Buffer.from([8]));
		expect([...(await later)]).toEqual([8]);
	});

	it('gives up on a snapshot with the source’s error', async () => {
		const src = fakeSource();
		const session = new CameraSession(src, 'k', { lingerMs: 50 });
		const shot = session.snapshot({ maxAgeMs: 2000, timeoutMs: 30 });
		(src as unknown as { start(s: FrameSink): void }).start({
			frame: () => {},
			error: () => {}
		});
		await expect(shot).rejects.toThrow(/no picture in time/);
	});

	it('ends viewers when stopped', () => {
		const session = new CameraSession(fakeSource(), 'k');
		let ended = 0;
		session.subscribe(
			() => {},
			() => ended++
		);
		session.stop();
		expect(ended).toBe(1);
	});
});

function fakePrinter(o: {
	model?: ModelCode;
	connected?: boolean;
	simulated?: boolean;
	camera?: CameraProtocol;
	snapshot?: Partial<PrinterSnapshot['camera']>;
	simPort?: number;
}) {
	const model = PRINTER_MODELS[o.model ?? 'N6'];
	return {
		id: 'p1',
		model,
		connected: o.connected ?? true,
		config: {
			id: 'p1',
			model: model.code,
			host: '192.168.1.20',
			serial: 'SERIAL',
			accessCode: '12345678',
			simulated: o.simulated ?? false,
			useTls: true,
			tlsPin: null
		},
		snapshot: emptySnapshot({
			camera: { ...emptySnapshot().camera, ...o.snapshot }
		}),
		camera: () => o.camera ?? model.camera,
		rawReport: () => ({
			model: model.code,
			pushall: { ipcam: o.simPort ? { sim_frame_port: o.simPort } : {} },
			get_version: {}
		})
	} as unknown as BambuPrinter;
}

const plan = (p: BambuPrinter | undefined, ffmpeg: string | null = '/usr/bin/ffmpeg') =>
	planCamera('p1', {
		printers: {
			get: () => p,
			statusOf: () => ({ configured: true, simulated: false }),
			list: () => (p ? [p] : [])
		},
		ffmpeg: () => ffmpeg
	});

describe('choosing the camera path', () => {
	it('uses RTSPS through ffmpeg, port-6000 JPEG, or says why not', () => {
		expect(plan(fakePrinter({ camera: 'rtsps' })).state).toMatchObject({
			available: true,
			path: 'rtsps'
		});
		expect(plan(fakePrinter({ camera: 'rtsp' })).state.path).toBe('rtsp');
		expect(plan(fakePrinter({ model: 'C12', camera: 'jpeg6000' })).state).toMatchObject({
			available: true,
			path: 'jpeg'
		});
		expect(plan(fakePrinter({ camera: 'rtsps' }), null).state).toMatchObject({
			available: false,
			reason: 'ffmpeg-missing',
			message: CAMERA_MESSAGES.ffmpegMissing
		});
		// A1/P1 cameras never need ffmpeg.
		expect(plan(fakePrinter({ model: 'N1', camera: 'jpeg6000' }), null).state.available).toBe(true);
	});

	it('asks for LAN Only Liveview when the printer reports it off', () => {
		expect(
			plan(fakePrinter({ camera: 'none', snapshot: { lanLiveview: 'disabled' } })).state
		).toMatchObject({ available: false, reason: 'liveview-off' });
	});

	it('says when the printer is offline, switched off or has no camera', () => {
		expect(plan(fakePrinter({ connected: false })).state.reason).toBe('offline');
		expect(plan(undefined).state.reason).toBe('switched-off');
		expect(plan(fakePrinter({ camera: 'none' })).state.reason).toBe('no-camera');
		expect(plan(fakePrinter({ snapshot: { present: false } })).state.reason).toBe('no-camera');
	});

	it('reaches simulated printers through the simulator’s frame server, whatever the model', () => {
		const p = plan(fakePrinter({ simulated: true, camera: 'rtsps', simPort: 40123 }));
		expect(p.ok && p.key).toBe('sim|192.168.1.20|40123|12345678');
		expect(p.state).toMatchObject({ available: true, path: 'jpeg', simulated: true });
		expect(plan(fakePrinter({ simulated: true })).state.reason).toBe('no-camera');
		// Only printers saved as simulated read the simulator's field.
		expect(plan(fakePrinter({ camera: 'rtsps', simPort: 40123 })).state.path).toBe('rtsps');
	});

	it('uses a new key when connection details change', () => {
		const a = plan(fakePrinter({ camera: 'rtsps' }));
		const printer = fakePrinter({ camera: 'rtsps' });
		(printer.config as { accessCode: string }).accessCode = 'changed1';
		const b = plan(printer);
		expect(a.ok && b.ok && a.key !== b.key).toBe(true);
	});
});

describe('media helpers', () => {
	it('sorts folders first then newest, and pairs thumbnails with videos', () => {
		const media = toMedia(
			'/timelapse',
			[
				{ name: 'old.mp4', type: 'file', size: 1, modified: '2026-01-01T00:00:00.000Z' },
				{ name: 'new.mp4', type: 'file', size: 2, modified: '2026-09-01T00:00:00.000Z' },
				{ name: 'thumbnail', type: 'dir', size: null, modified: null },
				{ name: 'old.jpg', type: 'file', size: 3, modified: '2026-01-01T00:00:00.000Z' }
			],
			[{ name: 'new.jpg', type: 'file', size: 4, modified: null }]
		);
		expect(media.map((m) => m.name)).toEqual(['thumbnail', 'new.mp4', 'old.jpg', 'old.mp4']);
		expect(media[1]).toMatchObject({
			path: '/timelapse/new.mp4',
			kind: 'video',
			thumbnail: '/timelapse/thumbnail/new.jpg'
		});
		expect(media[3].thumbnail).toBe('/timelapse/old.jpg');
		expect(media[0].kind).toBe('dir');
	});

	it('limits file connections per printer', async () => {
		const acquire = limiter(2);
		const r1 = await acquire('a');
		await acquire('a');
		await acquire('b');
		let third = false;
		const pending = acquire('a').then((r) => {
			third = true;
			return r;
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(third).toBe(false);
		r1();
		r1(); // releasing twice is harmless
		(await pending)();
		expect(third).toBe(true);
	});
});
