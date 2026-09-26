import { describe, expect, it } from 'vitest';
import golden from './commands.golden.json';
import { allCommands, commandDef, replyFailed, type CommandContext } from './registry';
import { PRINTER_MODELS, capabilitiesFor, type ModelCode } from '$lib/shared/printers/models';
import { emptySnapshot } from '$lib/shared/printers/status';
import { parse } from '../../validation';

const ctx = (model: ModelCode, state = 'IDLE'): CommandContext => ({
	printerId: 'p',
	model: PRINTER_MODELS[model],
	caps: capabilitiesFor(model, null),
	status: emptySnapshot({ gcodeState: state }),
	firmware: null
});

describe('printer commands', () => {
	it('registers every core command once, each citing its source', () => {
		const names = allCommands().map((c) => c.name);
		for (const n of [
			'pushing.pushall',
			'info.get_version',
			'print.project_file',
			'print.pause',
			'print.resume',
			'print.stop',
			'print.gcode_line'
		])
			expect(names).toContain(n);
		expect(new Set(names).size).toBe(names.length);
		for (const c of allCommands()) {
			expect(c.source, c.name).toMatch(/\w/);
			expect(c.name.startsWith(`${c.topic}.`), c.name).toBe(true);
		}
	});

	for (const g of golden)
		it(`${g.name} on the ${g.model} builds the documented payload`, () => {
			const def = commandDef(g.name)!;
			const params = parse(def.params, g.params);
			const body = def.build(params as never, ctx(g.model as ModelCode));
			expect({ [def.topic]: { sequence_id: 'SEQ', ...body } }).toEqual(g.payload);
			expect(def.qos ?? 0).toBe(g.qos);
		});

	it('guards by printer state and refuses bad parameters', () => {
		const pause = commandDef('print.pause')!;
		expect(pause.guard!(ctx('C12', 'PREPARE'), {})).toMatch(/preparing/);
		expect(pause.guard!(ctx('C12', 'IDLE'), {})).toMatch(/running print/);
		expect(pause.guard!(ctx('C12', 'RUNNING'), {})).toBeNull();
		expect(commandDef('print.resume')!.guard!(ctx('C12', 'RUNNING'), {})).toMatch(/paused/);
		expect(commandDef('print.stop')!.guard!(ctx('C12', 'IDLE'), {})).toMatch(/Nothing/);
		const start = commandDef('print.project_file')!;
		const params = parse(start.params, {
			file: 'a.gcode.3mf',
			plate: 1,
			title: 'a',
			useAms: false,
			amsMapping: []
		});
		expect(start.guard!(ctx('N6', 'RUNNING'), params)).toMatch(/busy/);
		expect(() => parse(start.params, { ...params, file: '../etc/passwd' })).toThrow(/file name/);
		expect(() => parse(start.params, { ...params, amsMapping: [20] })).toThrow(/tray/);
		const gcode = commandDef('print.gcode_line')!;
		expect(gcode.risk).toBe('parent');
		expect(gcode.guard!(ctx('N1'), { lines: ['M112'] })).toMatch(/emergency/);
		expect(gcode.guard!(ctx('N1'), { lines: ['M112'], allowEmergency: true })).toBeNull();
		expect(() => parse(gcode.params, { lines: Array(51).fill('G28') })).toThrow();
		expect(() => parse(gcode.params, { lines: ['G28\nM112'] })).toThrow(/printable/);
	});

	it('reads replies the way the printers write them', () => {
		expect(replyFailed({ command: 'pause' })).toBeNull();
		expect(replyFailed({ result: 'SUCCESS' })).toBeNull();
		expect(replyFailed({ result: 'success' })).toBeNull();
		expect(replyFailed({ result: 'fail', reason: 'busy' })).toBe('busy');
		expect(replyFailed({ result: 0 })).toBeNull();
		expect(replyFailed({ result: 3 })).toBe('error 3');
		expect(replyFailed({ result: 'success', err_code: 7, err_msg: 'no sd' })).toBe('no sd');
	});
});
