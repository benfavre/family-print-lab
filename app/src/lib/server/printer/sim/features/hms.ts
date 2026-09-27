// Printer errors on the simulated printer: control-page buttons raise real codes from Bambu's data
// (AMS runout, nozzle clog, first-layer problem) and the answers Bambu Studio sends clear them the way
// the firmware would (resume, ignore, clean_print_error, ams_control, buzzer_ctrl). The core feature
// handles resume and stop; a resumed or ended print clears the alert on the next step.
// Codes from Bambu Studio v02.08.02.61 resources/hms/hms_en_20P.json and hms_en_22E.json:
// 07xx2s00_00020001 "AMS <unit> Slot <s+1> filament has run out", print error 070u8011 "AMS filament ran
// out" (07FF8011 for the external spool), 03008016 "The nozzle is clogged with filament",
// 0C000300_0002000E "Your nozzle seems to be covered with jammed or clogged material",
// 0C000300_00030007 "Possible first layer defects have been detected". Pause stages 6, 35 and 34 are
// ha-bambulab const.py CURRENT_STAGE_IDS paused_filament_runout, paused_nozzle_clog and
// paused_first_layer_error.
import type { Json, SimFeature, SimPrinter } from '../core';

/** Printers paused by one of these alerts, until it is answered. */
const pending = new WeakSet<SimPrinter>();
const ACTIVE = ['PREPARE', 'RUNNING', 'PAUSE'];

function mustPrint(sim: SimPrinter) {
	if (sim.state.gcode_state !== 'RUNNING')
		throw new Error('Start a print first (it must be running).');
}

/** Pauses the running print with an error, the way the firmware does for a runout or a clog. */
function pauseWith(sim: SimPrinter, stage: number, hms: Json[], printError: number, why: string) {
	mustPrint(sim);
	const s = sim.state;
	s.gcode_state = 'PAUSE';
	s.stg_cur = stage;
	s.hms = hms;
	s.print_error = printError;
	pending.add(sim);
	sim.log(`⚠ ${why} (simulated): paused`);
	sim.report();
}

/** HMS and print error for a runout of the active tray. */
export function runoutCodes(tray: number | null): { hms: Json[]; printError: number } {
	if (tray !== null && tray >= 0 && tray < 16) {
		const unit = tray >> 2;
		const slot = tray & 3;
		return {
			hms: [{ attr: 0x07002000 | (unit << 16) | (slot << 8), code: 0x00020001 }],
			printError: 0x07008011 | (unit << 16)
		};
	}
	return { hms: [], printError: 0x07ff8011 };
}

/** Clears the alerts; a print that ended keeps its print error (FAILED shows why). */
function clear(sim: SimPrinter, why: string, keepError = false) {
	const s = sim.state;
	if (!s.hms?.length && (keepError || !s.print_error)) return pending.delete(sim);
	s.hms = [];
	if (!keepError) s.print_error = 0;
	pending.delete(sim);
	sim.log(`✓ alert cleared (${why})`);
	sim.report();
}

export const hms: SimFeature = {
	key: 'hms',
	command(sim, topic, msg) {
		const s = sim.state;
		if (topic === 'system' && msg.command === 'uiop') return 'silent';
		if (topic !== 'print') return undefined;
		switch (msg.command) {
			case 'ignore':
				if (s.gcode_state === 'PAUSE') sim.print.resume();
				clear(sim, 'ignored');
				return { result: 'success' };
			case 'idle_ignore':
				clear(sim, 'not reminded again');
				return { result: 'success' };
			case 'clean_print_error':
				if (Number(msg.print_error) === Number(s.print_error)) {
					s.print_error = 0;
					sim.log('✓ print error cleared');
					sim.report();
				}
				return { result: 'success' };
			case 'buzzer_ctrl':
				sim.log('🔕 buzzer off');
				return { result: 'success' };
			case 'ams_control':
				if (msg.param === 'resume' || msg.param === 'done') {
					if (s.gcode_state === 'PAUSE') sim.print.resume();
					clear(sim, `AMS ${msg.param}`);
				} else if (msg.param === 'abort') clear(sim, 'AMS abort');
				else return { result: 'failed', reason: 'Unknown AMS action' };
				return { result: 'success' };
			default:
				return undefined;
		}
	},
	step(sim) {
		if (!pending.has(sim)) return;
		const g = sim.state.gcode_state;
		// Resumed (core resume, with or without `err`), or the print ended (stopped, finished).
		if (g === 'RUNNING') clear(sim, 'resumed');
		else if (!ACTIVE.includes(g)) clear(sim, 'print ended', true);
	},
	controls: [
		{
			id: 'ams-runout',
			label: 'AMS filament runout',
			run(sim) {
				const tray = sim.job?.tray ?? null;
				const { hms: list, printError } = runoutCodes(tray);
				pauseWith(sim, 6, list, printError, `filament ran out in tray ${tray ?? '—'}`);
			}
		},
		{
			id: 'nozzle-clog',
			label: 'Nozzle clog',
			run(sim) {
				pauseWith(sim, 35, [{ attr: 0x0c000300, code: 0x0002000e }], 0x03008016, 'nozzle clogged');
			}
		},
		{
			id: 'first-layer',
			label: 'First layer problem',
			run(sim) {
				pauseWith(sim, 34, [{ attr: 0x0c000300, code: 0x00030007 }], 0, 'first layer defects');
			}
		},
		{
			id: 'fail-clog',
			label: 'Fail with nozzle clog',
			run(sim) {
				sim.print.fail(0x03008016, 'nozzle clogged');
			}
		},
		{
			id: 'clear-alerts',
			label: 'Clear alerts',
			run(sim) {
				clear(sim, 'from the control page');
			}
		}
	]
};
