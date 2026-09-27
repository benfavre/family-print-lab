// Camera settings on the printer: record timelapses, record prints, and the recording resolution.
// Payloads verified against OpenBambuAPI mqtt.md "camera.ipcam_record_set" / "camera.ipcam_timelapse"
// (https://github.com/Doridian/OpenBambuAPI at cc383a2) and Bambu Studio v02.08.02.61
// src/slic3r/GUI/DeviceManager.cpp command_ipcam_record / command_ipcam_timelapse /
// command_ipcam_resolution_set (~2133–2166; values "720p" and "1080p" per the cfg decoding ~4393).
// The printer acknowledges on the camera topic with the command and its control/resolution
// (DeviceManager.cpp ~3661–3685); the next report shows ipcam.timelapse / ipcam_record / resolution.
//
// origin: BambuStudio src/slic3r/GUI/DeviceManager.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
import { z } from 'zod';
import { defineCommand } from '../registry';

declare module '../registry' {
	interface CommandMap {
		'camera.ipcam_timelapse': { on: boolean };
		'camera.ipcam_record_set': { on: boolean };
		'camera.ipcam_resolution_set': { resolution: '720p' | '1080p' };
	}
}

const toggle = z.strictObject({ on: z.boolean() });

export default [
	defineCommand({
		name: 'camera.ipcam_timelapse',
		topic: 'camera',
		source:
			'OpenBambuAPI mqtt.md "camera.ipcam_timelapse"; Bambu Studio DeviceManager.cpp command_ipcam_timelapse ~2145',
		params: toggle,
		requires: ['timelapse'],
		guard: (ctx) =>
			ctx.status?.camera.present === false ? 'This printer reports no camera.' : null,
		build: ({ on }) => ({ command: 'ipcam_timelapse', control: on ? 'enable' : 'disable' }),
		settled: (s, { on }) => s.camera.timelapse === on,
		risk: 'safe'
	}),
	defineCommand({
		name: 'camera.ipcam_record_set',
		topic: 'camera',
		source:
			'OpenBambuAPI mqtt.md "camera.ipcam_record_set"; Bambu Studio DeviceManager.cpp command_ipcam_record ~2133',
		params: toggle,
		guard: (ctx) =>
			ctx.status?.camera.present === false ? 'This printer reports no camera.' : null,
		build: ({ on }) => ({ command: 'ipcam_record_set', control: on ? 'enable' : 'disable' }),
		settled: (s, { on }) => s.camera.recording === on,
		risk: 'safe'
	}),
	defineCommand({
		name: 'camera.ipcam_resolution_set',
		topic: 'camera',
		source: 'Bambu Studio DeviceManager.cpp command_ipcam_resolution_set ~2156, cfg decoding ~4393',
		params: z.strictObject({ resolution: z.enum(['720p', '1080p']) }),
		// Only printers that report a resolution have the setting (A1/P1 report an empty one or none).
		guard: (ctx) =>
			ctx.status && !ctx.status.camera.resolution
				? 'This printer has no camera resolution setting.'
				: null,
		build: ({ resolution }) => ({ command: 'ipcam_resolution_set', resolution }),
		settled: (s, { resolution }) => s.camera.resolution === resolution,
		risk: 'safe'
	})
];
