import { describe, expect, it } from 'vitest';
import golden from './controls.golden.json';
import { allCommands, commandDef, type CommandContext } from '../registry';
import { parseReport } from '../../report';
import { simState } from '../../sim/states';
import { PRINTER_MODELS, capabilitiesFor, type ModelCode } from '$lib/shared/printers/models';
import type { PrinterSnapshot } from '$lib/shared/printers/status';
import { parse } from '../../../validation';

/** A command context with the status the simulator starts from (the conformance fixtures' shape). */
function ctx(model: ModelCode, over: Partial<PrinterSnapshot> = {}): CommandContext {
	const status = parseReport(structuredClone(simState(model).print), {
		model: PRINTER_MODELS[model],
		versions: [],
		accessCodeSet: true
	});
	return {
		printerId: 'p',
		model: PRINTER_MODELS[model],
		caps: capabilitiesFor(model, null),
		status: { ...status, activeTray: null, ...over },
		firmware: null
	};
}

const guard = (name: string, c: CommandContext, params: Record<string, unknown>) => {
	const def = commandDef(name)!;
	const parsed = parse(def.params, params);
	const missing = (def.requires ?? []).filter((cap) => !c.caps[cap]);
	if (missing.length) return `missing ${missing.join(', ')}`;
	return def.guard?.(c, parsed as never) ?? null;
};

describe('printer control commands', () => {
	it('registers each control once, citing its source', () => {
		const names = allCommands().map((c) => c.name);
		for (const g of golden) expect(names).toContain(g.name);
		for (const c of allCommands().filter((c) => golden.some((g) => g.name === c.name)))
			expect(c.source, c.name).toMatch(/Bambu Studio|OpenBambuAPI|ha-bambulab/);
	});

	for (const g of golden)
		it(`${g.name} on the ${g.model} builds ${g.source}`, () => {
			const def = commandDef(g.name)!;
			const params = parse(def.params, g.params);
			const body = def.build(
				params as never,
				ctx(g.model as ModelCode, (g as { status?: Partial<PrinterSnapshot> }).status)
			);
			expect({ [def.topic]: { sequence_id: 'SEQ', ...body } }).toEqual(g.payload);
			expect(def.qos ?? 0).toBe(g.qos);
		});

	it('refuses temperatures above the model limit and controls the model lacks', () => {
		expect(guard('print.set_nozzle_temp', ctx('C12'), { temp: 300 })).toBeNull();
		expect(guard('print.set_nozzle_temp', ctx('C12'), { temp: 310 })).toMatch(/300 °C/);
		expect(guard('print.set_nozzle_temp', ctx('C12'), { temp: 200, nozzle: 1 })).toMatch(
			/one nozzle/
		);
		expect(guard('print.set_nozzle_temp', ctx('N6'), { temp: 200, nozzle: 1 })).toBeNull();
		expect(guard('print.set_bed_temp', ctx('N1'), { temp: 81 })).toMatch(/80 °C/);
		expect(guard('print.set_ctt', ctx('C12'), { temp: 40 })).toMatch(/missing chamberTempEdit/);
		expect(guard('print.set_ctt', ctx('N6'), { temp: 66 })).toMatch(/65 °C/);
		expect(guard('print.set_ctt', ctx('N6'), { temp: 45 })).toBeNull();
		expect(guard('system.ledctrl', ctx('N1'), { node: 'work_light', mode: 'on' })).toMatch(
			/no work light/
		);
		expect(guard('system.ledctrl', ctx('N6'), { node: 'work_light', mode: 'on' })).toBeNull();
		expect(guard('system.ledctrl', ctx('C12'), { node: 'heatbed_light', mode: 'on' })).toMatch(
			/no bed light/
		);
		expect(guard('print.set_fan', ctx('N1'), { fan: 'aux', percent: 50 })).toMatch(
			/no auxiliary fan/
		);
		expect(guard('print.set_fan', ctx('C12'), { fan: 'secondaryAux', percent: 50 })).toMatch(
			/second auxiliary/
		);
		expect(guard('print.set_airduct', ctx('C12'), { mode: 1 })).toMatch(/missing airductMode/);
		expect(guard('print.select_extruder', ctx('C12'), { nozzle: 1 })).toMatch(/missing dualNozzle/);
		expect(guard('print.buzzer_ctrl', ctx('N6'), { mode: 0 })).toMatch(/missing fireAlarmBuzzer/);
		expect(() => parse(commandDef('print.set_fan')!.params, { fan: 'part', percent: 55 })).toThrow(
			/10 %/
		);
	});

	it('allows each control only in the right printer state', () => {
		const running = { gcodeState: 'RUNNING' };
		expect(guard('print.print_speed', ctx('C12'), { level: 2 })).toMatch(/while printing/);
		expect(guard('print.print_speed', ctx('C12', running), { level: 2 })).toBeNull();
		expect(guard('print.back_to_center', ctx('C12', running), {})).toMatch(/Wait until/);
		expect(guard('print.back_to_center', ctx('C12'), {})).toBeNull();
		expect(guard('print.xyz_ctrl', ctx('C12', running), { axis: 'X', distance: 1 })).toMatch(
			/Wait/
		);
		expect(guard('print.xyz_ctrl', ctx('N6'), { axis: 'X', distance: 50 })).toMatch(/1, 10 mm/);
		expect(guard('print.xyz_ctrl', ctx('C12'), { axis: 'Z', distance: 50 })).toMatch(/1, 10 mm/);
		expect(guard('print.xyz_ctrl', ctx('C12'), { axis: 'X', distance: -50 })).toBeNull();
		expect(guard('print.set_extrusion_length', ctx('C12'), { length: 10 })).toMatch(/170 °C/);
		expect(
			guard('print.set_extrusion_length', ctx('C12', { nozzle: 200 }), { length: 10 })
		).toBeNull();
		expect(guard('print.skip_objects', ctx('N6'), { ids: [1] })).toMatch(/while printing/);
		expect(guard('print.skip_objects', ctx('N6', running), { ids: [1] })).toBeNull();
		// No partSkip bit (older firmware): allowed, like ha-bambulab; the bit clear: refused.
		expect(guard('print.skip_objects', ctx('C12', running), { ids: [1] })).toBeNull();
		expect(
			guard('print.skip_objects', ctx('N6', { ...running, firmwareSupport: { partSkip: false } }), {
				ids: [1]
			})
		).toMatch(/cannot skip/);
		expect(guard('print.calibration', ctx('C12'), {})).toMatch(/at least one/);
		expect(guard('print.calibration', ctx('C12'), { lidar: true })).toMatch(/no lidar/);
		expect(guard('print.calibration', ctx('BL-P001'), { lidar: true })).toBeNull();
		expect(guard('print.calibration', ctx('N1', running), { vibration: true })).toMatch(/Wait/);
		// Cooling mode while printing locks the chamber temperature (Bambu Studio on_set_chamber_temp).
		expect(guard('print.set_ctt', ctx('N6', { ...running, airductMode: 0 }), { temp: 45 })).toMatch(
			/cooling mode/
		);
	});

	it('loads and unloads filament only when that makes sense', () => {
		expect(guard('print.ams_change_filament', ctx('N6'), { tray: 1 })).toBeNull();
		expect(guard('print.ams_change_filament', ctx('C12'), { tray: 0 })).toMatch(
			/missing amsSwitchCommand/
		);
		const p1s = { ...ctx('C12'), caps: capabilitiesFor('C12', '01.08.02.00') };
		expect(guard('print.ams_change_filament', p1s, { tray: 2 })).toMatch(/empty/);
		expect(guard('print.ams_change_filament', p1s, { tray: 20 + 110 })).toMatch(/not on this/);
		expect(guard('print.ams_change_filament', p1s, { tray: 1 })).toBeNull();
		expect(
			guard(
				'print.ams_change_filament',
				{ ...p1s, status: { ...p1s.status!, gcodeState: 'RUNNING' } },
				{ tray: 1 }
			)
		).toMatch(/Wait/);
		expect(guard('print.ams_change_filament:unload', ctx('N6'), {})).toMatch(/No filament/);
		expect(guard('print.ams_change_filament:unload', ctx('N6', { activeTray: 1 }), {})).toBeNull();
	});

	it('guards custom G-code while printing', () => {
		const running = ctx('N1', { gcodeState: 'RUNNING' });
		expect(commandDef('print.gcode_line:custom')!.risk).toBe('parent');
		expect(guard('print.gcode_line:custom', running, { lines: ['G28'] })).toMatch(/G28 is blocked/);
		expect(guard('print.gcode_line:custom', running, { lines: ['m84'] })).toMatch(/M84/);
		expect(guard('print.gcode_line:custom', running, { lines: ['M106 P1 S255'] })).toBeNull();
		expect(guard('print.gcode_line:custom', ctx('N1'), { lines: ['G28'] })).toBeNull();
		expect(guard('print.gcode_line:custom', ctx('N1'), { lines: ['M112'] })).toMatch(/emergency/);
		expect(() =>
			parse(commandDef('print.gcode_line:custom')!.params, { lines: Array(51).fill('G1') })
		).toThrow();
		// Line numbers, leading spaces, comments and leading zeros do not slip past the blocklist.
		for (const line of [' G28', 'N10 G28', 'G28;home', 'G028 X', 'n5 m84'])
			expect(guard('print.gcode_line:custom', running, { lines: [line] }), line).toMatch(
				/is blocked while printing/
			);
		expect(guard('print.gcode_line:custom', ctx('N1'), { lines: ['N3 M112'] })).toMatch(
			/emergency/
		);
		expect(guard('print.gcode_line:custom', ctx('N1'), { lines: ['M1120'] })).toBeNull();
	});

	it('moves filament only through the nozzle in use, and sets the door check where reported', () => {
		const hot = { nozzle: 220, activeNozzle: 1 as const };
		expect(guard('print.set_extrusion_length', ctx('N6', hot), { length: 10 })).toBeNull();
		expect(guard('print.set_extrusion_length', ctx('N6', hot), { length: 10, nozzle: 0 })).toMatch(
			/nozzle in use/
		);
		expect(
			guard('print.set_extrusion_length', ctx('N6', hot), { length: 10, nozzle: 1 })
		).toBeNull();
		expect(guard('system.set_door_stat', ctx('N6'), { mode: 2 })).toBeNull();
		expect(guard('system.set_door_stat', ctx('C12'), { mode: 2 })).toMatch(/door check/);
		expect(guard('system.set_door_stat', ctx('N9'), { mode: 1 })).toMatch(/door check/);
	});
});
