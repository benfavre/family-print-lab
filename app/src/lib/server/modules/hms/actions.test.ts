import { describe, expect, it } from 'vitest';
import { ACTIONS, actionIdsFor, type ActionContext } from './actions';
import { commandDef, type CommandContext } from '$lib/server/printer/commands/registry';
import { PRINTER_MODELS, capabilitiesFor } from '$lib/shared/printers/models';

const ctx: CommandContext = {
	printerId: 'p',
	model: PRINTER_MODELS.N6,
	caps: capabilitiesFor('N6', null),
	status: null,
	firmware: null
};
const answer: ActionContext = { printError: 0x07008011, jobId: '812', subtaskId: '0' };

/** What pressing a button publishes: each command's body, as BambuPrinter.send builds it. */
function publish(id: number) {
	return ACTIONS[id].steps.map((step) => {
		const def = commandDef(step.name)!;
		const params = def.params.parse(step.params(answer));
		return { topic: def.topic, qos: def.qos ?? 0, body: def.build(params as never, ctx) };
	});
}

describe('HMS action buttons', () => {
	it('keeps only buttons we can send, and only for print errors', () => {
		expect(actionIdsFor('print_error', '07008011', [4, 6])).toEqual([4]);
		expect(actionIdsFor('print_error', '03008016', [4, 5, 6])).toEqual([4, 5]);
		expect(actionIdsFor('print_error', '0C00403D', [6, 11])).toEqual([11]);
		expect(actionIdsFor('hms', '0700200000020001', [4])).toEqual([]);
		// Bambu Studio's old "retry" errors get the pseudo Retry / Confirm pair.
		expect(actionIdsFor('print_error', '07FF8012', [11])).toEqual([10002, 10004]);
	});

	it('builds the resume, ignore and stop answers like Bambu Studio command_hms_*', () => {
		const err = String(0x07008011);
		expect(publish(4)).toEqual([
			{
				topic: 'print',
				qos: 1,
				body: { command: 'resume', err, param: 'reserve', job_id: '812' }
			}
		]);
		expect(publish(27)[0].body).toEqual({
			command: 'ignore',
			err,
			param: 'reserve',
			job_id: '812'
		});
		expect(publish(5)[0]).toEqual({
			topic: 'print',
			qos: 1,
			body: { command: 'stop', err, param: 'reserve', job_id: '812' }
		});
		expect(publish(23)[0].body).toEqual({ command: 'idle_ignore', err, type: 0 });
	});

	it('builds OK, Confirm, the AMS answers and the fire alarm', () => {
		expect(publish(11)).toEqual([
			{
				topic: 'print',
				qos: 0,
				body: { command: 'clean_print_error', subtask_id: '0', print_error: 0x07008011 }
			}
		]);
		expect(publish(10004).map((m) => m.body)).toEqual([
			{ command: 'clean_print_error', subtask_id: '0', print_error: 0x07008011 },
			{
				command: 'uiop',
				name: 'print_error',
				action: 'close',
				source: 1,
				type: 'dialog',
				err: '07008011'
			}
		]);
		expect(publish(7)[0].body).toEqual({ command: 'ams_control', param: 'done' });
		expect(publish(9)[0].body).toEqual({ command: 'ams_control', param: 'resume' });
		expect(publish(51)[0].body).toEqual({ command: 'ams_control', param: 'abort' });
		expect(publish(29)[0]).toEqual({
			topic: 'print',
			qos: 1,
			body: { command: 'buzzer_ctrl', mode: 0 }
		});
	});

	it('builds Recheck and Stop drying like command_refresh_nozzle and command_ams_drying_stop', () => {
		expect(publish(24)).toEqual([{ topic: 'print', qos: 1, body: { command: 'refresh_nozzle' } }]);
		expect(publish(35)).toEqual([
			{ topic: 'print', qos: 0, body: { command: 'auto_stop_ams_dry' } }
		]);
		// hms_action_093.json lists 23 and 24 for 05008081 (hotend not recognised), 35 for 0502C010.
		expect(actionIdsFor('print_error', '05008081', [23, 24])).toEqual([23, 24]);
		expect(actionIdsFor('print_error', '0502C010', [35])).toEqual([35]);
		expect(actionIdsFor('hms', '0500010000020001', [54])).toEqual([]);
	});

	it('marks the answers Bambu Studio refuses for laser and cutting tasks', () => {
		const printerOnly = Object.entries(ACTIONS)
			.filter(([, a]) => a.printerOnlyForProcessing)
			.map(([id]) => Number(id));
		expect(printerOnly).toEqual([2, 3, 4, 8, 9, 12, 23, 25, 27, 28, 34, 10002]);
		expect(ACTIONS[5].risk).toBe('confirm');
	});
});
