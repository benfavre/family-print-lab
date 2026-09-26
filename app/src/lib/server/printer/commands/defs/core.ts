// The core printer commands: ask for everything, versions, start a print, pause, resume, stop, and raw
// G-code (parent only; the controls package adds the safety guards around it). Payloads verified
// against OpenBambuAPI mqtt.md (https://github.com/Doridian/OpenBambuAPI at cc383a2), Bambu Studio
// v02.08.02.61 src/slic3r/GUI/DeviceManager.cpp and SelectMachine.cpp, and ha-bambulab
// pybambu/commands.py (https://github.com/greghesp/ha-bambulab at 0e027ff).
import { z } from 'zod';
import { defineCommand } from '../registry';
import { amsSlotOf } from '../../report';
import {
	ACTIVE_PRINTER_STATES,
	EXT_DEPUTY,
	EXT_MAIN,
	type GlobalTray
} from '$lib/shared/printers/status';

/** What to start: a plate of a file already uploaded to the printer's storage. */
export interface ProjectFileParams {
	/** The name the file was stored under on the printer. */
	file: string;
	/** 1-based plate number inside the file. */
	plate: number;
	/** Shown on the printer's screen and reported back while it prints. */
	title: string;
	md5?: string;
	useAms: boolean;
	/** One entry per filament in the file, in filament order: the global tray, or -1 when unused. */
	amsMapping: GlobalTray[];
	bedType?: string;
	timelapse?: boolean;
	bedLeveling?: boolean;
	flowCalibration?: boolean;
}

const none = z.strictObject({}) as unknown as z.ZodType<Record<string, never>>;
const tray = z
	.number()
	.int()
	.refine(
		(t) =>
			t === -1 ||
			(t >= 0 && t < 16) ||
			(t >= 24 && t <= 27) ||
			(t >= 128 && t <= 135) ||
			t === EXT_MAIN ||
			t === EXT_DEPUTY,
		'Not a filament tray.'
	);

const active = (state: string | undefined) => !!state && ACTIVE_PRINTER_STATES.has(state);

/** A global tray inside an AMS (AMS 0–15, AMS Lite on the A2L 24–27, AMS HT 128–135). */
const isAmsTray = (t: GlobalTray) =>
	(t >= 0 && t < 16) || (t >= 24 && t <= 27) || (t >= 128 && t <= 135);

/**
 * Whether the printer feeds from the AMS, decided from the mapping the way Bambu Studio does
 * (SelectMachine.cpp ~3358–3373 with _HasAms/_HasExt ~2620–2643, and do_ams_mapping ~1275
 * STUDIO-11971): false on a printer that reports no AMS unit, false when every filament maps to an
 * external spool (or the mapping is empty), true when at least one maps to an AMS tray.
 */
export function feedsFromAms(
	requested: boolean,
	mapping: GlobalTray[],
	status: { ams: unknown[] } | null
): boolean {
	if (!requested) return false;
	if (status && status.ams.length === 0) return false;
	return mapping.some(isAmsTray);
}

export default [
	defineCommand({
		name: 'pushing.pushall',
		topic: 'pushing',
		source:
			'OpenBambuAPI mqtt.md "pushing.pushall"; Bambu Studio DeviceManager.cpp command_request_push_all ~1330',
		params: none,
		build: () => ({ command: 'pushall', version: 1, push_target: 1 }),
		// The answer is a full push_status report, not a reply.
		reply: 'none',
		risk: 'safe'
	}),
	defineCommand({
		name: 'info.get_version',
		topic: 'info',
		source:
			'OpenBambuAPI mqtt.md "info.get_version"; Bambu Studio DeviceManager.cpp command_get_version ~1270 (QoS 1)',
		params: none,
		build: () => ({ command: 'get_version' }),
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.project_file',
		topic: 'print',
		source:
			'OpenBambuAPI mqtt.md "print.project_file"; mapping per Bambu Studio SelectMachine.cpp get_ams_mapping_result ~1424–1510, use_ams per ~3358–3373; url form per ha-bambulab const.py LEGACY_SDCARD_PRINTERS',
		params: z.strictObject({
			file: z
				.string()
				.regex(/^[\w .()+-]{1,120}$/, 'That file name cannot be sent to the printer.'),
			plate: z.number().int().min(1).max(200),
			title: z.string().max(200),
			md5: z
				.string()
				.regex(/^[0-9a-fA-F]{32}$/)
				.or(z.literal(''))
				.optional(),
			useAms: z.boolean(),
			amsMapping: z.array(tray).max(32),
			bedType: z.string().max(40).optional(),
			timelapse: z.boolean().optional(),
			bedLeveling: z.boolean().optional(),
			flowCalibration: z.boolean().optional()
		}),
		guard: (ctx) =>
			active(ctx.status?.gcodeState) ? 'The printer is busy with another print.' : null,
		build: (o, ctx) => ({
			command: 'project_file',
			param: `Metadata/plate_${o.plate}.gcode`,
			url: ctx.model.printUrl === 'sdcard' ? `file:///sdcard/${o.file}` : `ftp:///${o.file}`,
			file: '',
			md5: o.md5 ?? '',
			project_id: '0',
			profile_id: '0',
			task_id: '0',
			subtask_id: '0',
			subtask_name: o.title.slice(0, 60),
			bed_type: o.bedType ?? 'auto',
			timelapse: o.timelapse ?? false,
			bed_levelling: o.bedLeveling ?? true,
			flow_cali: o.flowCalibration ?? true,
			vibration_cali: true,
			layer_inspect: false,
			use_ams: feedsFromAms(o.useAms, o.amsMapping, ctx.status),
			// One entry per filament: the tray index, -1 for unused and for external spools.
			ams_mapping: o.amsMapping.map((t) => (t === EXT_MAIN || t === EXT_DEPUTY ? -1 : t)),
			// Dual-nozzle printers read this form: { ams_id, slot_id } per filament, {255, 255} unused.
			ams_mapping2: o.amsMapping.map(amsSlotOf)
		}),
		settled: (s) => active(s.gcodeState),
		timeoutMs: 15_000,
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.pause',
		topic: 'print',
		source:
			'OpenBambuAPI mqtt.md "print.pause" (QoS 1); Bambu Studio DeviceManager.cpp command_task_pause ~1439',
		params: none,
		// While preparing (heating, levelling) the printer accepts the command but ignores it.
		guard: (ctx) =>
			ctx.status?.gcodeState === 'PREPARE'
				? 'The printer is still preparing; pause once it starts printing.'
				: ctx.status?.gcodeState !== 'RUNNING'
					? 'Only a running print can pause.'
					: null,
		build: () => ({ command: 'pause', param: '' }),
		settled: (s) => s.gcodeState === 'PAUSE',
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.resume',
		topic: 'print',
		source:
			'OpenBambuAPI mqtt.md "print.resume" (QoS 1); Bambu Studio DeviceManager.cpp command_task_resume ~1449',
		params: none,
		guard: (ctx) => (ctx.status?.gcodeState !== 'PAUSE' ? 'Nothing is paused.' : null),
		build: () => ({ command: 'resume', param: '' }),
		settled: (s) => s.gcodeState === 'RUNNING',
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.stop',
		topic: 'print',
		source:
			'OpenBambuAPI mqtt.md "print.stop" (QoS 1); Bambu Studio DeviceManager.cpp command_task_abort ~1418',
		params: none,
		guard: (ctx) => (active(ctx.status?.gcodeState) ? null : 'Nothing is printing.'),
		build: () => ({ command: 'stop', param: '' }),
		settled: (s) => !active(s.gcodeState),
		qos: 1,
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.gcode_line',
		topic: 'print',
		source:
			'OpenBambuAPI mqtt.md "print.gcode_line"; ha-bambulab commands.py SEND_GCODE_TEMPLATE (lines joined with \\n)',
		params: z.strictObject({
			lines: z
				.array(
					z
						.string()
						.max(256)
						.regex(/^[\x20-\x7e]*$/, 'G-code lines must be plain printable text.')
				)
				.min(1)
				.max(50),
			allowEmergency: z.boolean().optional()
		}),
		guard: (_ctx, o) =>
			!o.allowEmergency && o.lines.some((l) => /^\s*M112\b/i.test(l))
				? 'M112 is an emergency stop; it needs the printer restarted afterwards.'
				: null,
		build: (o) => ({ command: 'gcode_line', param: `${o.lines.join('\n')}\n` }),
		timeoutMs: 5000,
		risk: 'parent'
	})
];
