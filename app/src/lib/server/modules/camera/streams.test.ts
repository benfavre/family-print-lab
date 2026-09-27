// The byte-level pieces of the camera: the port-6000 auth packet and framing, the MJPEG writer for the
// browser, ffmpeg's mpjpeg output, the ffmpeg command line, and the port-6000 client against the
// simulator's frame server.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
	authPacket,
	FrameParser,
	frameHeader,
	isJpeg,
	jpeg6000Source,
	MAX_FRAME,
	readAuthPacket
} from './jpeg6000';
import { BOUNDARY, mjpegPart, MpjpegParser } from './mjpeg';
import { ffmpegArgs, ffmpegProblem, ffmpegSource, rtspUrl } from './ffmpeg';
import { frameServer } from '$lib/server/printer/sim/features/camera';

const jpeg = (n: number, fill = 0x11) =>
	Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, fill), Buffer.from([0xff, 0xd9])]);

describe('port-6000 auth packet', () => {
	it('is 80 bytes: 0x40, 0x3000, 0, 0, user and access code NUL padded (OpenBambuAPI video.md)', () => {
		const p = authPacket('bblp', '12345678');
		expect(p.length).toBe(80);
		expect(p.readUInt32LE(0)).toBe(0x40);
		expect(p.readUInt32LE(4)).toBe(0x3000);
		expect(p.readUInt32LE(8)).toBe(0);
		expect(p.readUInt32LE(12)).toBe(0);
		expect(p.subarray(16, 20).toString('ascii')).toBe('bblp');
		expect(p.subarray(20, 48).every((b) => b === 0)).toBe(true);
		expect(p.subarray(48, 56).toString('ascii')).toBe('12345678');
		expect(p.subarray(56, 80).every((b) => b === 0)).toBe(true);
		expect(readAuthPacket(p)).toEqual({ username: 'bblp', accessCode: '12345678' });
		expect(readAuthPacket(Buffer.alloc(80))).toBeNull();
	});
});

describe('port-6000 frames', () => {
	it('splits frames whatever the chunking', () => {
		const frames: Buffer[] = [];
		const parser = new FrameParser((f) => frames.push(f));
		const a = jpeg(1000, 1);
		const b = jpeg(5000, 2);
		const stream = Buffer.concat([frameHeader(a.length), a, frameHeader(b.length), b]);
		// One byte at a time, then odd chunks.
		for (const byte of stream.subarray(0, 700)) parser.push(Buffer.from([byte]));
		for (let i = 700; i < stream.length; i += 999) parser.push(stream.subarray(i, i + 999));
		expect(frames.map((f) => f.length)).toEqual([a.length, b.length]);
		expect(frames[0].equals(a)).toBe(true);
		expect(frames[1].equals(b)).toBe(true);
	});

	it('has the header layout the printer sends: size, itrack 0, flags 1, 0', () => {
		const h = frameHeader(1234);
		expect([h.readUInt32LE(0), h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)]).toEqual([
			1234, 0, 1, 0
		]);
	});

	it('refuses impossible sizes and payloads that are not JPEGs', () => {
		const parser = new FrameParser(() => {});
		expect(() => parser.push(frameHeader(MAX_FRAME + 1))).toThrow(/size/);
		expect(() => new FrameParser(() => {}).push(frameHeader(0))).toThrow(/size/);
		const bad = Buffer.alloc(10, 7);
		expect(() => new FrameParser(() => {}).push(Buffer.concat([frameHeader(10), bad]))).toThrow(
			/not a picture/
		);
		expect(isJpeg(jpeg(3))).toBe(true);
		expect(isJpeg(Buffer.from([0xff, 0xd8]))).toBe(false);
	});

	it('reads frames from the simulated camera and reconnects after a drop', async () => {
		const port = await frameServer();
		const source = jpeg6000Source({ host: '127.0.0.1', port, accessCode: '12345678' });
		const frames: Buffer[] = [];
		const errors: string[] = [];
		await new Promise<void>((resolve) => {
			source.start({
				frame: (f) => {
					frames.push(f);
					if (frames.length === 2) resolve();
				},
				error: (m) => errors.push(m)
			});
		});
		source.stop();
		expect(frames.every(isJpeg)).toBe(true);
		expect(errors).toEqual([]);
	});

	it('is refused by the simulated camera without a proper auth packet', async () => {
		const port = await frameServer();
		const source = jpeg6000Source({ host: '127.0.0.1', port, accessCode: '' });
		const message = await new Promise<string>((resolve) =>
			source.start({ frame: () => {}, error: resolve })
		);
		source.stop();
		expect(message).toMatch(/closed|refused/i);
	});
});

describe('MJPEG for the browser', () => {
	it('writes one multipart part per frame', () => {
		const f = jpeg(10);
		const part = mjpegPart(f);
		const head = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`;
		expect(part.subarray(0, head.length).toString()).toBe(head);
		expect(part.subarray(head.length, head.length + f.length).equals(f)).toBe(true);
		expect(part.subarray(-2).toString()).toBe('\r\n');
	});
});

describe("ffmpeg's mpjpeg output", () => {
	// The shape libavformat/mpjpeg.c writes.
	const part = (f: Buffer) =>
		Buffer.concat([
			Buffer.from(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${f.length}\r\n\r\n`),
			f,
			Buffer.from('\r\n')
		]);

	it('splits parts by their Content-Length, in any chunking', () => {
		const frames: Buffer[] = [];
		const parser = new MpjpegParser((f) => frames.push(f));
		const a = jpeg(300, 1);
		const b = jpeg(20, 2);
		const all = Buffer.concat([part(a), part(b), part(a)]);
		for (let i = 0; i < all.length; i += 7) parser.push(all.subarray(i, i + 7));
		expect(frames.map((f) => f.length)).toEqual([a.length, b.length, a.length]);
		expect(frames[1].equals(b)).toBe(true);
	});

	it('gives up on output without sizes', () => {
		const parser = new MpjpegParser(() => {});
		expect(() => parser.push(Buffer.from('--ffmpeg\r\nContent-type: image/jpeg\r\n\r\n'))).toThrow(
			/without a size/
		);
		expect(() => new MpjpegParser(() => {}).push(Buffer.alloc(9000, 65))).toThrow(/no pictures/);
	});
});

describe('the ffmpeg command', () => {
	it('builds the stream URL from the saved address, with the access code escaped', () => {
		expect(rtspUrl({ protocol: 'rtsps', host: '192.168.1.20', accessCode: '12345678' })).toBe(
			'rtsps://bblp:12345678@192.168.1.20:322/streaming/live/1'
		);
		expect(rtspUrl({ protocol: 'rtsp', host: '192.168.1.20', accessCode: 'a@b/c' })).toBe(
			'rtsp://bblp:a%40b%2Fc@192.168.1.20:554/streaming/live/1'
		);
		expect(rtspUrl({ protocol: 'rtsps', host: 'fe80::1', accessCode: 'x' })).toBe(
			'rtsps://bblp:x@[fe80::1]:322/streaming/live/1'
		);
	});

	it('asks for RTSP over TCP, no audio, 10 JPEG frames a second as mpjpeg on stdout', () => {
		expect(ffmpegArgs('rtsps://x')).toEqual([
			'-hide_banner',
			'-loglevel',
			'error',
			'-rtsp_transport',
			'tcp',
			'-i',
			'rtsps://x',
			'-an',
			'-c:v',
			'mjpeg',
			'-q:v',
			'6',
			'-r',
			'10',
			'-f',
			'mpjpeg',
			'-'
		]);
	});

	it('explains failures without the access code', () => {
		expect(ffmpegProblem('method DESCRIBE failed: 401 Unauthorized', '1234')).toMatch(
			/refused the access code/
		);
		expect(ffmpegProblem('Connection refused', '1234')).toMatch(/LAN Only Liveview/);
		const other = ffmpegProblem('rtsps://bblp:SECRET99@host: Invalid data found', 'SECRET99');
		expect(other).not.toContain('SECRET99');
		expect(other).toMatch(/stopped/);
	});

	it('turns ffmpeg output into frames and restarts it when it dies', async () => {
		const runs: { args: string[]; stdout: PassThrough; child: EventEmitter }[] = [];
		const fakeSpawn = ((_cmd: string, args: string[]) => {
			const child = new EventEmitter() as EventEmitter & {
				stdout: PassThrough;
				stderr: PassThrough;
				kill: () => void;
			};
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = () => child.emit('close', null);
			runs.push({ args, stdout: child.stdout, child });
			return child;
		}) as never;
		const source = ffmpegSource({
			ffmpeg: '/usr/bin/ffmpeg',
			url: 'rtsps://bblp:code@h:322/streaming/live/1',
			accessCode: 'code',
			spawn: fakeSpawn
		});
		const frames: Buffer[] = [];
		const errors: string[] = [];
		source.start({ frame: (f) => frames.push(f), error: (m) => errors.push(m) });
		await new Promise((r) => setTimeout(r, 10));
		const f = jpeg(50);
		runs[0].stdout.write(
			Buffer.concat([
				Buffer.from(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${f.length}\r\n\r\n`),
				f,
				Buffer.from('\r\n')
			])
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(frames).toHaveLength(1);
		expect(runs[0].args).toContain('rtsps://bblp:code@h:322/streaming/live/1');
		runs[0].child.emit('close', 1);
		expect(errors).toEqual(['The camera stream stopped.']);
		source.stop();
	});

	it('does not start ffmpeg when the certificate check refuses', async () => {
		let spawned = 0;
		const source = ffmpegSource({
			ffmpeg: '/usr/bin/ffmpeg',
			url: 'rtsps://x',
			accessCode: 'code',
			precheck: async () => 'This printer’s security certificate changed.',
			spawn: (() => {
				spawned++;
				throw new Error('should not run');
			}) as never
		});
		const message = await new Promise<string>((resolve) =>
			source.start({ frame: () => {}, error: resolve })
		);
		source.stop();
		expect(message).toMatch(/certificate changed/);
		expect(spawned).toBe(0);
	});
});
