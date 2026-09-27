// The simulated camera and timelapse folder. Each simulated printer serves generated JPEG frames the
// A1/P1 port-6000 way (auth packet, 16-byte header + JPEG; OpenBambuAPI video.md) on a free port of
// 127.0.0.1, plain TCP, and reports that port as ipcam.sim_frame_port. RTSPS models report
// ipcam.rtsp_url as well, so their live report looks like a real one with LAN Only Liveview on, but the
// app reaches them through the same JPEG server (a simplification: no RTSP server or ffmpeg needed in
// development; modules/camera/service.ts). The frame server checks the auth packet's shape and user,
// not the access code (a feature does not see it). The file service gets a /timelapse folder with two
// videos and thumbnails, and a new one whenever a print finishes with timelapse on. Camera commands
// (ipcam_timelapse, ipcam_record_set, ipcam_resolution_set) change the ipcam block like the firmware.
import net from 'node:net';
import type { Json, SimFeature, SimPrinter } from '../core';
import { frameHeader, readAuthPacket } from '../../../modules/camera/jpeg6000';
import { SIM_FRAMES, SIM_THUMBNAIL, SIM_TIMELAPSE } from './camera-fixtures';

const FRAMES = SIM_FRAMES.map((f) => Buffer.from(f, 'base64'));
const TIMELAPSE = Buffer.from(SIM_TIMELAPSE, 'base64');
const THUMBNAIL = Buffer.from(SIM_THUMBNAIL, 'base64');
/** Real A1/P1 cameras send about a frame a second; a little faster reads as "live" in development. */
const FRAME_MS = 700;

const pad = (n: number) => String(n).padStart(2, '0');
/** "video_2026-09-27_14-03-11" in UTC. */
export function timelapseName(at: Date): string {
	return `video_${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}_${pad(at.getUTCHours())}-${pad(at.getUTCMinutes())}-${pad(at.getUTCSeconds())}`;
}

/** Adds a timelapse (and its thumbnail) to the simulated file service. */
export function addTimelapse(sim: SimPrinter, at = new Date()) {
	const name = timelapseName(at);
	const stamp = at.toISOString();
	const files = sim.files as Map<string, { name: string; data: Buffer; at: string }>;
	files.set(`timelapse/${name}.mp4`, { name: `${name}.mp4`, data: TIMELAPSE, at: stamp });
	files.set(`timelapse/thumbnail/${name}.jpg`, {
		name: `${name}.jpg`,
		data: THUMBNAIL,
		at: stamp
	});
	sim.log(`🎞 timelapse saved: ${name}.mp4`);
}

/**
 * Pictures another feature shows instead of the test pattern while it has one (ai-vision: a simulated
 * print, and spaghetti on demand). Returning null falls back to the test pattern.
 */
export const simFrameSources = new WeakMap<SimPrinter, () => Buffer | null>();

/** Serves frames to every client that sends a valid auth packet. Resolves with the port. */
export function frameServer(
	log: (m: string) => void = () => {},
	next: () => Buffer | null = () => null
): Promise<number> {
	let frame = 0;
	const server = net.createServer((socket) => {
		let buffer = Buffer.alloc(0);
		let timer: NodeJS.Timeout | undefined;
		socket.on('error', () => {});
		socket.on('close', () => clearInterval(timer));
		socket.setTimeout(10_000, () => socket.destroy());
		socket.on('data', (chunk: Buffer) => {
			if (timer) return;
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length < 80) return;
			const auth = readAuthPacket(buffer);
			if (!auth || auth.username !== 'bblp' || !auth.accessCode) {
				log('✕ camera: refused a connection with a bad auth packet');
				return void socket.destroy();
			}
			socket.setTimeout(0);
			const send = () => {
				const jpeg = next() ?? FRAMES[frame++ % FRAMES.length];
				socket.write(Buffer.concat([frameHeader(jpeg.length), jpeg]));
			};
			send();
			timer = setInterval(send, FRAME_MS);
			timer.unref?.();
		});
	});
	server.unref();
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
	});
}

const lastState = new WeakMap<SimPrinter, string>();

function ipcam(sim: SimPrinter): Json {
	sim.state.ipcam ??= {};
	return sim.state.ipcam;
}

function liveviewOn(sim: SimPrinter, port: number) {
	const cam = ipcam(sim);
	if (sim.model.camera === 'rtsps') cam.rtsp_url = `rtsps://127.0.0.1:${port}/streaming/live/1`;
	else cam.liveview = { ...(cam.liveview ?? {}), local: 'local' };
}

function liveviewOff(sim: SimPrinter) {
	const cam = ipcam(sim);
	if (sim.model.camera === 'rtsps') cam.rtsp_url = 'disable';
	else cam.liveview = { ...(cam.liveview ?? {}), local: 'disabled' };
}

export const camera: SimFeature = {
	key: 'camera',
	init(sim) {
		if (sim.model.camera === 'none') return;
		const day = 86_400_000;
		addTimelapse(sim, new Date(Date.now() - 3 * day));
		addTimelapse(sim, new Date(Date.now() - day));
		frameServer(sim.log, () => simFrameSources.get(sim)?.() ?? null)
			.then((port) => {
				ipcam(sim).sim_frame_port = port;
				liveviewOn(sim, port);
				sim.report();
			})
			.catch((error: Error) => sim.log(`✕ camera: ${error.message}`));
	},
	step(sim) {
		const now = String(sim.state.gcode_state ?? '');
		const before = lastState.get(sim);
		lastState.set(sim, now);
		if (before && before !== 'FINISH' && now === 'FINISH' && ipcam(sim).timelapse === 'enable')
			addTimelapse(sim);
	},
	command(sim, topic, msg) {
		if (topic !== 'camera') return undefined;
		const cam = ipcam(sim);
		const control = msg.control === 'enable' ? 'enable' : 'disable';
		switch (msg.command) {
			case 'ipcam_timelapse':
				cam.timelapse = control;
				sim.log(`timelapse ${control}d`);
				break;
			case 'ipcam_record_set':
				cam.ipcam_record = control;
				sim.log(`recording ${control}d`);
				break;
			case 'ipcam_resolution_set':
				if (msg.resolution !== '720p' && msg.resolution !== '1080p')
					return { result: 'failed', reason: 'Unknown resolution' };
				cam.resolution = msg.resolution;
				sim.report();
				return { result: 'success', extra: { resolution: msg.resolution } };
			default:
				return undefined;
		}
		sim.report();
		return { result: 'success', extra: { control } };
	},
	controls: [
		{
			id: 'camera-liveview',
			label: 'LAN liveview on/off',
			run(sim) {
				const cam = ipcam(sim);
				const off =
					sim.model.camera === 'rtsps'
						? cam.rtsp_url === 'disable'
						: cam.liveview?.local === 'disabled';
				if (off && cam.sim_frame_port) liveviewOn(sim, cam.sim_frame_port);
				else liveviewOff(sim);
				sim.log(off ? 'LAN liveview on' : 'LAN liveview off');
				sim.report();
			}
		},
		{ id: 'camera-timelapse', label: 'Add a timelapse', run: (sim) => addTimelapse(sim) }
	]
};
