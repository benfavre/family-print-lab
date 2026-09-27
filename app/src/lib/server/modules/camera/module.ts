// The camera package: live view for every printer model (port-6000 JPEG on the A1 and P1, RTSP(S)
// through ffmpeg on the others), snapshots for other packages, and the printer's timelapse folder.
// Routes: /api/printers/[id]/camera/{,stream,snapshot.jpg}, /api/printers/[id]/files{,/download},
// /api/camera/settings. Camera state changes go out on the live channel "camera:state".
import { defineModule } from '$lib/server/modules';
import type { CameraService } from '$lib/server/modules/contracts';
import type { SettingsStore } from '$lib/server/module-settings';
import type { CameraSettings } from '$lib/shared/camera';
import { CAMERA_SETTINGS_DEFAULTS } from '$lib/shared/camera';
import { createCameraService, type CameraManager } from './service';
import { findFfmpeg } from './ffmpeg';
import { createMedia, type Media } from './media';
import { cameraSettingsSchema } from './validation';

export interface CameraModule extends CameraService, CameraManager {
	media: Media;
	settings: SettingsStore<CameraSettings>;
	/** ffmpeg's path, or null. */
	ffmpeg(): string | null;
}

declare module '$lib/server/modules' {
	interface ModuleServices {
		camera: CameraModule;
	}
}

let current: CameraModule | null = null;

export default defineModule({
	key: 'camera',
	order: 60,
	// Kid pages may show a printer's camera (watching a print is half the fun); files stay grown-up only.
	kidReads: [/^\/api\/printers\/[^/]+\/camera(\/(stream|snapshot\.jpg))?$/],
	start(ctx) {
		const settings = ctx.settings(cameraSettingsSchema, CAMERA_SETTINGS_DEFAULTS);
		// Looked up at most every 30 s, so installing ffmpeg works without a restart.
		let found: { path: string | null; at: number } | null = null;
		const ffmpeg = () => {
			if (!found || Date.now() - found.at > 30_000)
				found = { path: findFfmpeg(ctx.env), at: Date.now() };
			return found.path;
		};
		const service = createCameraService({
			printers: ctx.printers,
			ffmpeg,
			onState: (state) => ctx.live.send('camera:state', state)
		});
		// Streams follow the printer: settings changed, removed, or gone offline.
		const connected = new Map<string, boolean>();
		const onUpdate = (id: string) => {
			const now = !!ctx.printers.get(id)?.connected;
			if (connected.get(id) === now) return;
			connected.set(id, now);
			service.refresh();
		};
		const onChanged = () => service.refresh();
		ctx.printers.on('update', onUpdate);
		ctx.printers.on('changed', onChanged);
		const module: CameraModule = {
			...service,
			media: createMedia({}),
			settings,
			ffmpeg,
			stop() {
				ctx.printers.off('update', onUpdate);
				ctx.printers.off('changed', onChanged);
				service.stop();
			}
		};
		current = module;
		return module;
	},
	stop() {
		current?.stop();
		current = null;
	},
	integrations() {
		const path = current?.ffmpeg() ?? findFfmpeg();
		return [
			{
				id: 'camera',
				kind: 'module',
				name: 'Printer cameras',
				via: path ? `ffmpeg at ${path}` : 'ffmpeg, for some printers',
				available: !!path,
				detail: path
					? 'Live view works for every printer model.'
					: 'A1 and P1 cameras work as they are. X1, P2S, H2 and X2 cameras need ffmpeg on this computer.',
				powers: ['Live camera on the printer page', 'Snapshots', 'Timelapse downloads'],
				setup: [
					{ text: 'Install ffmpeg (Debian or Ubuntu)', command: 'sudo apt install ffmpeg' },
					{ text: 'Or on a Mac with Homebrew', command: 'brew install ffmpeg' },
					{ text: 'Or set FFMPEG_PATH to where ffmpeg is, then restart the app.' }
				]
			}
		];
	}
});
