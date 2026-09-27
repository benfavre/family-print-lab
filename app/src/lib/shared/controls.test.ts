import { describe, expect, it } from 'vitest';
import {
	calibrationSteps,
	detectorReason,
	fanReason,
	gcodeCommand,
	gcodeLines,
	gcodeReason,
	jogSteps,
	lightReason,
	newFanProtocol,
	offlineReason,
	pickId,
	tempReason,
	type ControlTarget
} from './controls';
import { PRINTER_MODELS, capabilitiesFor, type ModelCode } from './printers/models';
import { emptySnapshot, type PrinterSnapshot } from './printers/status';

const target = (model: ModelCode, over: Partial<PrinterSnapshot> = {}): ControlTarget => ({
	model: PRINTER_MODELS[model],
	caps: capabilitiesFor(model, null),
	status: emptySnapshot({ gcodeState: 'IDLE', ...over })
});

describe('which controls a printer has', () => {
	// The plan's acceptance printers: X2D, P1S, A1 mini.
	const table: [ModelCode, string, string | null][] = [
		['N6', 'chamber temperature', null],
		['C12', 'chamber temperature', 'The P1S cannot heat its chamber.'],
		['N1', 'chamber temperature', 'The A1 mini cannot heat its chamber.'],
		['N6', 'work light', null],
		['C12', 'work light', 'The P1S has no work light.'],
		['N1', 'work light', 'The A1 mini has no work light.'],
		['N6', 'aux fan', null],
		['C12', 'aux fan', null],
		['N1', 'aux fan', 'The A1 mini has no auxiliary fan.'],
		['N6', 'second aux fan', null],
		['C12', 'second aux fan', 'The P1S has no second auxiliary fan.']
	];
	for (const [model, control, reason] of table)
		it(`${PRINTER_MODELS[model].short}: ${control}`, () => {
			const t = target(model);
			const got =
				control === 'chamber temperature'
					? tempReason(t, 'chamber', 40)
					: control === 'work light'
						? lightReason(t, 'work_light')
						: control === 'aux fan'
							? fanReason(t, 'aux')
							: fanReason(t, 'secondaryAux');
			expect(got).toBe(reason);
		});

	it('offers calibration steps and jog steps per model', () => {
		expect(calibrationSteps(target('BL-P001'))).toEqual(['lidar', 'bedLeveling', 'vibration']);
		expect(calibrationSteps(target('N1'))).toEqual(['bedLeveling', 'vibration', 'motorNoise']);
		expect(jogSteps(target('C12'), 'X')).toEqual([1, 10, 50]);
		expect(jogSteps(target('C12'), 'Z')).toEqual([1, 10]);
		expect(jogSteps(target('N6', { firmwareSupport: { mqttAxis: true } }), 'X')).toEqual([1, 10]);
	});

	it('lists a check the printer reports even when the catalogue leaves it out', () => {
		expect(detectorReason(target('N6'), 'first_layer_inspector')).toMatch(/does not have/);
		expect(
			detectorReason(
				target('N6', { xcam: { ...emptySnapshot().xcam, firstLayer: true } }),
				'first_layer_inspector'
			)
		).toBeNull();
		expect(detectorReason(target('BL-P001'), 'spaghetti_detector')).toBeNull();
	});

	it('uses set_fan only with the new protocol and an airduct', () => {
		expect(newFanProtocol(emptySnapshot({ airductMode: 0 }))).toBe(false);
		expect(newFanProtocol(emptySnapshot({ airductMode: 0, newProtocol: true }))).toBe(true);
		expect(newFanProtocol(emptySnapshot({ newProtocol: true }))).toBe(false);
	});

	it('explains why nothing works when offline or without Developer Mode', () => {
		expect(offlineReason({ connected: false })).toMatch(/not connected/);
		expect(
			offlineReason({ connected: true, state: emptySnapshot({ developerMode: false }) })
		).toMatch(/Developer Mode/);
		expect(offlineReason({ connected: true, state: emptySnapshot() })).toBeNull();
	});

	it('reads G-code from a text box and blocks the dangerous lines while printing', () => {
		expect(gcodeLines('G28 ; home\n\n  M104 S200  \n;only a comment')).toEqual([
			'G28',
			'M104 S200'
		]);
		const running = target('N1', { gcodeState: 'RUNNING' });
		expect(gcodeReason(running, ['M500'])).toMatch(/M500 is blocked while printing/);
		expect(gcodeReason(running, ['M104 S210'])).toBeNull();
		expect(gcodeReason(target('N1'), ['M500'])).toBeNull();
		expect(gcodeReason(target('N1'), [])).toMatch(/at least one/);
		expect(gcodeReason(target('N1'), ['M112'])).toMatch(/emergency stop/);
		expect(gcodeReason(target('N1'), ['M104 S200 ; 200°'])).toMatch(/plain printable/);
		expect(gcodeReason(target('N1'), Array(51).fill('G4'))).toMatch(/at most 50/);
		expect(gcodeReason(target('N1'), ['G1'.padEnd(257, '0')])).toMatch(/256 characters/);
	});

	it('reads identify ids from pick image pixels the way Bambu Studio paints them', () => {
		// identify_id 0x0a0b0c → r 0x0c, g 0x0b, b 0x0a (GLCanvas3D.cpp render_thumbnail).
		expect(pickId(0x0c, 0x0b, 0x0a, 255)).toBe(0x0a0b0c);
		expect(pickId(139, 0, 0, 255)).toBe(139);
		expect(pickId(0, 0, 0, 0)).toBeNull();
		expect(pickId(139, 0, 0, 128)).toBeNull();
	});

	it('finds the command word of a G-code line however it is written', () => {
		expect(gcodeCommand('G28')).toBe('G28');
		expect(gcodeCommand('  g028 x y')).toBe('G28');
		expect(gcodeCommand('N120 M84*47')).toBe('M84');
		expect(gcodeCommand('M500;save')).toBe('M500');
		expect(gcodeCommand('G0 X1')).toBe('G0');
		expect(gcodeCommand('G00')).toBe('G0');
		expect(gcodeCommand('G29.1')).toBe('G29.1');
		expect(gcodeCommand('T1')).toBe('T1');
		expect(gcodeCommand('; comment')).toBeNull();
		expect(gcodeCommand('hello')).toBeNull();
	});
});
