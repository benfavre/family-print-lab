// Bambu's action ids (the buttons in its error dialog) → our labels and the commands they send, read
// from Bambu Studio v02.08.02.61 src/slic3r/GUI/DeviceErrorDialog.hpp (ActionButton enum),
// DeviceErrorDialog.cpp init_button_list ~183 (labels) and on_button_click ~535 (what each does).
// Ids that only move Bambu Studio's own window around (Check Assistant 6, View Liveview 13, the rack
// page 49), that do nothing (Load Filament 10, Cancel 37), or that need data we do not have (Proceed
// 41 and Don't Remind Me 57 need the dialog's action JSON; Recheck 24, Stop Drying 35 and Disable
// Purification 54 use commands this app does not implement yet) are left out: no button.
import type { CommandMap, CommandName } from '$lib/server/printer/commands/registry';

/** What a button needs to fill in its command. */
export interface ActionContext {
	/** The print error being answered (Bambu sends the dialog's error, `m_error_code`). */
	printError: number;
	/** The report's `job_id` and `subtask_id` ("" when the printer sends none). */
	jobId: string;
	subtaskId: string;
}

type Step = {
	[N in CommandName]: { name: N; params: (c: ActionContext) => CommandMap[N] };
}[CommandName];

export interface ActionDef {
	label: string;
	/** Sent in order. */
	steps: Step[];
	risk: 'safe' | 'confirm';
	/**
	 * Bambu Studio refuses these for tasks such as laser cutting (MachineObject::check_resume_condition,
	 * DeviceManager.cpp: job_attr bits 4–7 above 1 → "can only be resumed on printer").
	 */
	printerOnlyForProcessing?: boolean;
}

const err = (c: ActionContext) => String(c.printError >>> 0);
const resume: Step = {
	name: 'print.resume:hms',
	params: (c) => ({ err: err(c), jobId: c.jobId })
};
const ignore: Step = {
	name: 'print.ignore:hms',
	params: (c) => ({ err: err(c), jobId: c.jobId })
};
const ams = (param: 'resume' | 'done' | 'abort'): Step => ({
	name: 'print.ams_control:hms',
	params: () => ({ param })
});
const clean: Step = {
	name: 'print.clean_print_error:hms',
	params: (c) => ({ subtaskId: c.subtaskId, printError: c.printError })
};

/** By Bambu's action id. */
export const ACTIONS: Record<number, ActionDef> = {
	2: { label: 'Resume printing', steps: [resume], risk: 'safe', printerOnlyForProcessing: true },
	3: {
		label: 'Resume (defects acceptable)',
		steps: [resume],
		risk: 'safe',
		printerOnlyForProcessing: true
	},
	4: {
		label: 'Resume (problem solved)',
		steps: [resume],
		risk: 'safe',
		printerOnlyForProcessing: true
	},
	5: {
		label: 'Stop printing',
		steps: [{ name: 'print.stop:hms', params: (c) => ({ err: err(c), jobId: c.jobId }) }],
		risk: 'confirm'
	},
	7: { label: 'Filament extruded, continue', steps: [ams('done')], risk: 'safe' },
	8: {
		label: 'Not extruded yet, retry',
		steps: [ams('resume')],
		risk: 'safe',
		printerOnlyForProcessing: true
	},
	9: {
		label: 'Finished, continue',
		steps: [ams('resume')],
		risk: 'safe',
		printerOnlyForProcessing: true
	},
	11: { label: 'OK', steps: [clean], risk: 'safe' },
	12: {
		label: 'Filament loaded, resume',
		steps: [resume],
		risk: 'safe',
		printerOnlyForProcessing: true
	},
	23: {
		label: 'Don’t remind me again',
		steps: [{ name: 'print.idle_ignore:hms', params: (c) => ({ err: err(c), type: 0 }) }],
		risk: 'safe',
		printerOnlyForProcessing: true
	},
	25: {
		label: 'Ignore, don’t remind me again',
		steps: [ignore],
		risk: 'safe',
		printerOnlyForProcessing: true
	},
	27: { label: 'Ignore and resume', steps: [ignore], risk: 'safe', printerOnlyForProcessing: true },
	28: {
		label: 'Problem solved, resume',
		steps: [resume],
		risk: 'safe',
		printerOnlyForProcessing: true
	},
	29: {
		label: 'Turn off the fire alarm',
		steps: [{ name: 'print.buzzer_ctrl:hms', params: () => ({}) }],
		risk: 'safe'
	},
	34: {
		label: 'Retry (problem solved)',
		steps: [ams('resume')],
		risk: 'safe',
		printerOnlyForProcessing: true
	},
	51: { label: 'Abort', steps: [ams('abort')], risk: 'confirm' },
	// Pseudo ids Bambu Studio gives the old "retry" errors (convert_to_pseudo_buttons ~284): Retry
	// resumes the AMS (StatusPanel.cpp on_ams_retry ~5451), Confirm clears the error on both sides.
	10002: { label: 'Retry', steps: [ams('resume')], risk: 'safe', printerOnlyForProcessing: true },
	10004: {
		label: 'Confirm',
		steps: [
			clean,
			{ name: 'system.uiop:print_error', params: (c) => ({ printError: c.printError }) }
		],
		risk: 'safe'
	}
};

/** Print errors Bambu Studio answers with the pseudo Retry/Confirm pair (DeviceErrorDialog.cpp ~13). */
const RETRY_ERRORS = new Set([
	'07018004',
	'07018005',
	'07018007',
	'07018012',
	'07028012',
	'07038012',
	'07FF8012',
	'07FF8013'
]);

/**
 * The action ids to show for a code, in Bambu's order, without the ones we cannot send. Only print
 * errors get buttons: Bambu Studio answers only those (its error dialog is for `print_error`), and
 * the commands carry the print error as `err`.
 */
export function actionIdsFor(kind: 'hms' | 'print_error', key: string, listed: number[]): number[] {
	if (kind !== 'print_error') return [];
	const ids = RETRY_ERRORS.has(key) ? [10002, 10004] : listed;
	return [...new Set(ids)].filter((id) => id in ACTIONS);
}
