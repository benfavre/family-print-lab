// The commands behind the buttons Bambu shows with a printer error ("Resume", "Retry", "OK"…), built
// exactly like Bambu Studio v02.08.02.61 src/slic3r/GUI/DeviceManager.cpp builds them (line numbers at
// that tag). The hms module picks which one a button sends (modules/hms/actions.ts, after
// DeviceErrorDialog.cpp on_button_click ~535).
//
// origin: BambuStudio src/slic3r/GUI/DeviceManager.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
import { z } from 'zod';
import { defineCommand } from '../registry';

/** The error being answered: the print error as a decimal string, as Bambu Studio sends it. */
interface HmsErrParams {
	err: string;
	/** The report's `job_id` ("" when the printer sends none). */
	jobId: string;
}

declare module '../registry' {
	interface CommandMap {
		'print.resume:hms': HmsErrParams;
		'print.ignore:hms': HmsErrParams;
		'print.stop:hms': HmsErrParams;
		'print.idle_ignore:hms': { err: string; type: number };
		'print.clean_print_error:hms': { subtaskId: string; printError: number };
		'system.uiop:print_error': { printError: number };
		'print.buzzer_ctrl:hms': Record<string, never>;
		'print.ams_control:hms': { param: 'resume' | 'done' | 'abort' };
		'print.refresh_nozzle:hms': Record<string, never>;
		'print.auto_stop_ams_dry:hms': Record<string, never>;
	}
}

const err = z.string().regex(/^\d{1,10}$/, 'Not a printer error code.');
const jobId = z.string().max(40);
const errParams = z.strictObject({ err, jobId });
const printError = z.number().int().min(1).max(0xffffffff);
const none = z.strictObject({}) as unknown as z.ZodType<Record<string, never>>;

export default [
	defineCommand({
		name: 'print.resume:hms',
		topic: 'print',
		source: 'Bambu Studio DeviceManager.cpp command_hms_resume ~1473 (QoS 1)',
		params: errParams,
		build: (o) => ({ command: 'resume', err: o.err, param: 'reserve', job_id: o.jobId }),
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.ignore:hms',
		topic: 'print',
		source: 'Bambu Studio DeviceManager.cpp command_hms_ignore ~1487 (QoS 1)',
		params: errParams,
		build: (o) => ({ command: 'ignore', err: o.err, param: 'reserve', job_id: o.jobId }),
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.stop:hms',
		topic: 'print',
		source: 'Bambu Studio DeviceManager.cpp command_hms_stop ~1501 (QoS 1)',
		params: errParams,
		build: (o) => ({ command: 'stop', err: o.err, param: 'reserve', job_id: o.jobId }),
		qos: 1,
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.idle_ignore:hms',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_hms_idle_ignore ~1461 (QoS 1); type 0 per DeviceErrorDialog.cpp ~589',
		params: z.strictObject({ err, type: z.number().int().min(0).max(255) }),
		build: (o) => ({ command: 'idle_ignore', err: o.err, type: o.type }),
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.clean_print_error:hms',
		topic: 'print',
		source: 'Bambu Studio DeviceManager.cpp command_clean_print_error ~1379',
		params: z.strictObject({ subtaskId: z.string().max(40), printError }),
		build: (o) => ({
			command: 'clean_print_error',
			subtask_id: o.subtaskId,
			print_error: o.printError
		}),
		// Some firmware never answers; the report clearing print_error settles it.
		settled: (s, o) => s.printError !== o.printError,
		timeoutMs: 5000,
		risk: 'safe'
	}),
	defineCommand({
		name: 'system.uiop:print_error',
		topic: 'system',
		source:
			'Bambu Studio DeviceManager.cpp command_clean_print_error_uiop ~1390 (source 1 = Studio, err as %08X)',
		params: z.strictObject({ printError }),
		build: (o) => ({
			command: 'uiop',
			name: 'print_error',
			action: 'close',
			source: 1,
			type: 'dialog',
			err: (o.printError >>> 0).toString(16).toUpperCase().padStart(8, '0')
		}),
		reply: 'none',
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.buzzer_ctrl:hms',
		topic: 'print',
		source: 'Bambu Studio DeviceManager.cpp command_stop_buzzer ~1561 (mode 0, QoS 1)',
		params: none,
		build: () => ({ command: 'buzzer_ctrl', mode: 0 }),
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.ams_control:hms',
		topic: 'print',
		source: 'Bambu Studio DeviceManager.cpp command_ams_control ~1763',
		params: z.strictObject({ param: z.enum(['resume', 'done', 'abort']) }),
		build: (o) => ({ command: 'ams_control', param: o.param }),
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.refresh_nozzle:hms',
		topic: 'print',
		source: 'Bambu Studio DeviceManager.cpp command_refresh_nozzle ~1622 (QoS 1)',
		params: none,
		build: () => ({ command: 'refresh_nozzle' }),
		qos: 1,
		timeoutMs: 5000,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.auto_stop_ams_dry:hms',
		topic: 'print',
		source: 'Bambu Studio DeviceManager.cpp command_ams_drying_stop ~1778',
		params: none,
		build: () => ({ command: 'auto_stop_ams_dry' }),
		timeoutMs: 5000,
		risk: 'safe'
	})
];
