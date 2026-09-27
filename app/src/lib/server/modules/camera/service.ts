// The camera service: decides how each printer's camera is reached right now, keeps one shared stream
// per printer (session.ts) and answers snapshots for other packages (CameraService).
//
// Which path, as Bambu Studio decides it from the live report (DeviceManager.cpp ~3450–3466,
// MediaPlayCtrl.cpp ~440 at v02.08.02.61; BambuPrinter.camera() does the mapping): "rtsps" → RTSPS on
// 322, "rtsp" → RTSP on 554, "local" or a port-6000 model → JPEG on 6000, "disable" → the person has
// to turn on LAN Only Liveview on the printer; no report yet → the catalogue default. The address is
// always the saved one, never the host inside ipcam.rtsp_url.
//
// Simulated printers: the simulator serves generated JPEG frames the port-6000 way on a free port of
// its own and reports that port as ipcam.sim_frame_port (sim/features/camera.ts), for every model, so
// RTSPS models are simulated through the JPEG path too (no ffmpeg or RTSP server needed). Only printers
// saved as simulated ever read that field.
import type tls from 'node:tls';
import type { BambuPrinter } from '$lib/server/printer/bambu';
import type { PrinterManager } from '$lib/server/printer/manager';
import { printerTlsOptions, verifyPrinterCert } from '$lib/server/printer/tls';
import { AppError } from '$lib/server/validation';
import type { CameraService } from '$lib/server/modules/contracts';
import type { CameraPath, CameraState } from '$lib/shared/camera';
import { CameraSession, type SessionState } from './session';
import { jpeg6000Source } from './jpeg6000';
import { checkRtspsCertificate, ffmpegSource, rtspUrl } from './ffmpeg';
import type { CameraSource } from './source';

export const JPEG_PORT = 6000;

export const CAMERA_MESSAGES = {
	switchedOff: 'This printer is switched off in Integrations → Printers.',
	offline: 'The printer is offline, so its camera is too.',
	noCamera: 'This printer has no camera the app can show.',
	liveviewOff:
		'Turn on “LAN Only Liveview” on the printer’s screen (in its network or general settings) to see the camera here.',
	ffmpegMissing:
		'Live view for this printer needs ffmpeg on the computer running Family Print Lab. Install it (for example “sudo apt install ffmpeg”), then reload this page.',
	starting: 'Starting the camera…',
	live: 'Live.'
} as const;

/** How to reach one printer's camera, or why not. */
export type CameraPlan =
	| { ok: false; state: CameraState }
	| { ok: true; state: CameraState; key: string; source: () => CameraSource };

export interface CameraServiceOptions {
	printers: Pick<PrinterManager, 'get' | 'statusOf' | 'list'>;
	/** ffmpeg's path, or null when it is missing (looked up again on each plan). */
	ffmpeg: () => string | null;
	onState?: (state: CameraState) => void;
	lingerMs?: number;
}

function base(printerId: string, simulated: boolean): CameraState {
	return {
		printerId,
		available: false,
		path: null,
		reason: null,
		message: '',
		live: false,
		lastFrameAt: null,
		simulated
	};
}

/** The port the simulator serves frames on, for printers saved as simulated. */
function simulatorPort(p: BambuPrinter): number | null {
	const ipcam = p.rawReport().pushall.ipcam as Record<string, unknown> | undefined;
	const port = Number(ipcam?.sim_frame_port);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** Works out how to reach a printer's camera (pure apart from reading the printer's state). */
export function planCamera(
	printerId: string,
	o: Pick<CameraServiceOptions, 'printers' | 'ffmpeg'>
): CameraPlan {
	const p = o.printers.get(printerId);
	if (!p) {
		const status = o.printers.statusOf(printerId); // 404 when it does not exist
		return {
			ok: false,
			state: {
				...base(printerId, !!status.simulated),
				reason: 'switched-off',
				message: CAMERA_MESSAGES.switchedOff
			}
		};
	}
	const { host, accessCode, serial, simulated = false, useTls = true, tlsPin } = p.config;
	const state = base(printerId, simulated);
	if (!p.connected)
		return {
			ok: false,
			state: { ...state, reason: 'offline', message: CAMERA_MESSAGES.offline }
		};
	const snap = p.snapshot;
	if (simulated) {
		const port = simulatorPort(p);
		if (!port || snap?.camera.lanLiveview === 'disabled')
			return {
				ok: false,
				state: {
					...state,
					reason: port ? 'liveview-off' : 'no-camera',
					message: port ? CAMERA_MESSAGES.liveviewOff : CAMERA_MESSAGES.noCamera
				}
			};
		return {
			ok: true,
			state: { ...state, available: true, path: 'jpeg', message: CAMERA_MESSAGES.starting },
			key: `sim|${host}|${port}|${accessCode}`,
			source: () => jpeg6000Source({ host, port, accessCode })
		};
	}
	if (snap?.camera.lanLiveview === 'disabled')
		return {
			ok: false,
			state: { ...state, reason: 'liveview-off', message: CAMERA_MESSAGES.liveviewOff }
		};
	const protocol = p.camera();
	if (protocol === 'none' || snap?.camera.present === false)
		return {
			ok: false,
			state: { ...state, reason: 'no-camera', message: CAMERA_MESSAGES.noCamera }
		};
	// The same trust decision as MQTT and FTPS, but never trust on first use from here.
	const tlsPolicy = useTls
		? {
				options: printerTlsOptions(serial) as tls.ConnectionOptions,
				verify: (socket: tls.TLSSocket) => {
					const r = verifyPrinterCert(socket, { serial, pin: tlsPin ?? null, mayPin: false });
					return r.ok ? null : r.error;
				}
			}
		: undefined;
	const path: CameraPath = protocol === 'jpeg6000' ? 'jpeg' : protocol;
	if (path === 'jpeg')
		return {
			ok: true,
			state: { ...state, available: true, path, message: CAMERA_MESSAGES.starting },
			key: `jpeg|${host}|${accessCode}|${tlsPin ?? ''}`,
			source: () => jpeg6000Source({ host, port: JPEG_PORT, accessCode, tls: tlsPolicy })
		};
	const ffmpeg = o.ffmpeg();
	if (!ffmpeg)
		return {
			ok: false,
			state: { ...state, path, reason: 'ffmpeg-missing', message: CAMERA_MESSAGES.ffmpegMissing }
		};
	const url = rtspUrl({ protocol: path, host, accessCode });
	return {
		ok: true,
		state: { ...state, available: true, path, message: CAMERA_MESSAGES.starting },
		key: `${path}|${host}|${accessCode}|${tlsPin ?? ''}|${ffmpeg}`,
		source: () =>
			ffmpegSource({
				ffmpeg,
				url,
				accessCode,
				precheck:
					path === 'rtsps' && tlsPolicy
						? () => checkRtspsCertificate({ host, ...tlsPolicy })
						: undefined
			})
	};
}

export interface CameraManager extends CameraService {
	state(printerId: string): CameraState;
	/**
	 * Every frame to fn until the returned function is called (onEnd when the stream stops first).
	 * Throws a 409 when there is no camera.
	 */
	subscribe(printerId: string, fn: (jpeg: Buffer) => void, onEnd?: () => void): () => void;
	/** Re-checks running streams (printer settings changed, printer removed). */
	refresh(): void;
	stop(): void;
}

export function createCameraService(o: CameraServiceOptions): CameraManager {
	const sessions = new Map<string, CameraSession>();

	const merge = (state: CameraState, s: SessionState | undefined): CameraState => {
		if (!state.available || !s) return state;
		return {
			...state,
			live: s.live,
			lastFrameAt: s.lastFrameAt,
			...(s.error && !s.live && { reason: 'error' as const, message: s.error }),
			...(s.live && { message: CAMERA_MESSAGES.live })
		};
	};

	const plan = (id: string) => planCamera(id, o);

	function session(id: string): CameraSession {
		const p = plan(id);
		if (!p.ok) throw new AppError(409, p.state.message);
		let s = sessions.get(id);
		if (s && s.key !== p.key) s.replace(p.source(), p.key);
		if (!s) {
			const created: CameraSession = new CameraSession(p.source(), p.key, {
				lingerMs: o.lingerMs,
				onState: (st) => {
					try {
						o.onState?.(merge(plan(id).state, st));
					} catch {
						/* the printer went away meanwhile */
					}
				}
			});
			s = created;
			sessions.set(id, s);
		}
		return s;
	}

	return {
		has(id) {
			try {
				return plan(id).ok;
			} catch {
				return false;
			}
		},
		state(id) {
			return merge(plan(id).state, sessions.get(id)?.state());
		},
		async getSnapshot(id, opts = {}) {
			const s = session(id);
			try {
				return await s.snapshot({ maxAgeMs: opts.maxAgeMs ?? 2000, signal: opts.signal });
			} catch (error) {
				// No picture in time, or the stream failed: the person gets the reason, not a server error.
				if (opts.signal?.aborted) throw error;
				throw new AppError(503, (error as Error).message);
			}
		},
		subscribe(id, fn, onEnd) {
			return session(id).subscribe(fn, onEnd);
		},
		refresh() {
			for (const [id, s] of sessions) {
				let p: CameraPlan | null = null;
				try {
					p = plan(id);
				} catch {
					/* removed */
				}
				if (!p?.ok) {
					s.stop();
					sessions.delete(id);
				} else if (p.key !== s.key) s.replace(p.source(), p.key);
			}
		},
		stop() {
			for (const s of sessions.values()) s.stop();
			sessions.clear();
		}
	};
}
