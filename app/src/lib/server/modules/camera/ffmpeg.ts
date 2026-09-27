// The X1/P2S/H2/X2 camera: RTSPS on port 322 (or plain RTSP on 554), H.264 from a live555 server with
// Digest auth, user "bblp" and the access code, path /streaming/live/1 (OpenBambuAPI video.md at
// cc383a2; ClusterM open-bamboo-networking research/06.05-rtsp.md). One ffmpeg per printer turns it
// into JPEGs (`-f mpjpeg`), which the session fans out to every viewer; ffmpeg also sends the RTCP
// receiver reports live555 expects. ffmpeg cannot apply our certificate policy (CN = serial, pin), so
// before starting it we open one TLS connection to port 322 ourselves with printer/tls.ts and refuse
// when that check fails.
//
// Privacy note: the RTSP URL carries the access code, and while ffmpeg runs its command line is
// visible to other programs on this computer (`ps`). It is never logged or sent anywhere. Keeping it
// inside our own process needs an RTSP-over-TLS client of our own (a later improvement).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import tls from 'node:tls';
import { MpjpegParser } from './mjpeg';
import type { CameraSource, FrameSink } from './source';

export const RTSPS_PORT = 322;
export const RTSP_PORT = 554;

/** Where to find ffmpeg: FFMPEG_PATH, else the usual places. Null when there is none. */
export function findFfmpeg(env: Record<string, string | undefined> = process.env): string | null {
	const candidates = env.FFMPEG_PATH
		? [env.FFMPEG_PATH]
		: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
	for (const path of candidates) {
		try {
			fs.accessSync(path, fs.constants.X_OK);
			return path;
		} catch {
			/* next */
		}
	}
	return null;
}

/** The printer's stream URL, always built from the saved address (never the host in the report). */
export function rtspUrl(o: {
	protocol: 'rtsps' | 'rtsp';
	host: string;
	accessCode: string;
	port?: number;
}): string {
	const port = o.port ?? (o.protocol === 'rtsps' ? RTSPS_PORT : RTSP_PORT);
	const host = o.host.includes(':') ? `[${o.host}]` : o.host;
	return `${o.protocol}://bblp:${encodeURIComponent(o.accessCode)}@${host}:${port}/streaming/live/1`;
}

/** ffmpeg's arguments: RTSP over TCP in, 10 JPEG frames a second out on stdout. */
export function ffmpegArgs(url: string): string[] {
	return [
		'-hide_banner',
		'-loglevel',
		'error',
		'-rtsp_transport',
		'tcp',
		'-i',
		url,
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
	];
}

/** ffmpeg's error output in plain words, without the access code. */
export function ffmpegProblem(stderr: string, accessCode: string): string {
	const text = accessCode ? stderr.replaceAll(accessCode, '••••') : stderr;
	if (/401|unauthori[sz]ed/i.test(text))
		return 'The printer refused the access code for the camera.';
	if (/connection refused/i.test(text))
		return 'The printer refused the camera connection. Is LAN Only Liveview on?';
	if (/timed out|timeout/i.test(text)) return 'The camera did not answer in time.';
	const last = text.trim().split('\n').at(-1)?.trim();
	return last ? `The camera stream stopped (${last.slice(0, 160)}).` : 'The camera stream stopped.';
}

/**
 * Opens one TLS connection to the RTSPS port and runs the certificate policy on it; resolves null
 * when the printer is the one we trust, else the reason. Nothing is written to the socket.
 */
export function checkRtspsCertificate(o: {
	host: string;
	port?: number;
	options: tls.ConnectionOptions;
	verify: (socket: tls.TLSSocket) => string | null;
	timeoutMs?: number;
}): Promise<string | null> {
	return new Promise((resolve) => {
		const socket = tls.connect({ ...o.options, host: o.host, port: o.port ?? RTSPS_PORT }, () => {
			const refused = o.verify(socket);
			socket.destroy();
			resolve(refused);
		});
		socket.setTimeout(o.timeoutMs ?? 8000, () => {
			socket.destroy();
			resolve('The camera did not answer. Is LAN Only Liveview on?');
		});
		socket.on('error', (error: NodeJS.ErrnoException) =>
			resolve(
				error.code === 'ECONNREFUSED'
					? 'The printer refused the camera connection. Is LAN Only Liveview on?'
					: error.message || 'The camera connection failed.'
			)
		);
	});
}

export interface FfmpegSourceOptions {
	ffmpeg: string;
	url: string;
	accessCode: string;
	/** Runs before each start (the RTSPS certificate check); a string refuses. */
	precheck?: () => Promise<string | null>;
	/** No frame for this long: restart ffmpeg. */
	stallMs?: number;
	spawn?: typeof spawn;
}

export function ffmpegSource(o: FfmpegSourceOptions): CameraSource {
	let child: ChildProcess | null = null;
	let timer: NodeJS.Timeout | undefined;
	let stall: NodeJS.Timeout | undefined;
	let stopped = true;
	let retry = 0;
	let sink: FrameSink;
	const run = o.spawn ?? spawn;

	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(start, Math.min(30_000, 2000 * 2 ** retry++));
		timer.unref?.();
	};
	const armStall = (p: ChildProcess) => {
		clearTimeout(stall);
		stall = setTimeout(() => p.kill('SIGKILL'), o.stallMs ?? 20_000);
		stall.unref?.();
	};

	async function start() {
		if (stopped) return;
		const refused = await o.precheck?.();
		if (stopped) return;
		if (refused) {
			sink.error(refused);
			return schedule();
		}
		let stderr = '';
		let failure: string | null = null;
		const p = run(o.ffmpeg, ffmpegArgs(o.url), { stdio: ['ignore', 'pipe', 'pipe'] });
		child = p;
		const parser = new MpjpegParser((jpeg) => {
			retry = 0;
			armStall(p);
			sink.frame(jpeg);
		});
		armStall(p);
		p.stdout?.on('data', (chunk: Buffer) => {
			try {
				parser.push(chunk);
			} catch (error) {
				failure = (error as Error).message;
				p.kill('SIGKILL');
			}
		});
		p.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
		p.on('error', (error) => (failure ??= `Could not start ffmpeg (${error.message}).`));
		p.on('close', () => {
			clearTimeout(stall);
			if (child === p) child = null;
			if (stopped) return;
			sink.error(failure ?? ffmpegProblem(stderr, o.accessCode));
			schedule();
		});
	}

	return {
		start(s) {
			if (!stopped) return;
			sink = s;
			stopped = false;
			retry = 0;
			void start();
		},
		stop() {
			stopped = true;
			clearTimeout(timer);
			clearTimeout(stall);
			child?.kill('SIGKILL');
			child = null;
		}
	};
}
