import { describe, expect, it } from 'vitest';
import {
	flowByObject,
	layerTemperatures,
	paOverrides,
	retractionLengths,
	speedsByHeight
} from './gcode-checks';

// Lines as upstream's GCodeWriter and GCode.cpp write them (see gcode-checks.ts).
const gcode = [
	'M900 K0.040', // the start G-code's own calibration line, not an override
	'; Z_HEIGHT: 0.2',
	'M400',
	' M900 K0; Override pressure advance value',
	'M104 S230 ; set nozzle temperature',
	'; Calib_Retraction_tower: Z_HEIGHT: 0.2, length:0',
	'; OBJECT_ID: 7',
	'; FEATURE: Outer wall',
	'G1 F3000',
	'G1 X10 Y0 E0.5',
	'G1 X20 Y0 E0.5',
	'; Z_HEIGHT: 1.2',
	' M901 P0.75 K0.002; Override pressure advance value',
	'M104 S230 ; set nozzle temperature',
	'M104 S225 ; set nozzle temperature',
	'; Calib_Retraction_tower: Z_HEIGHT: 1.2, length:0.1',
	'; OBJECT_ID: 7',
	'; FEATURE: Outer wall',
	'G1 F6000',
	'G1 X30 Y0 E0.5',
	'; OBJECT_ID: 9',
	'; FEATURE: Outer wall',
	'G1 X40 Y0 E0.6',
	'; FEATURE: Sparse infill',
	'G1 X50 Y0 E2',
	'G1 X50.5 Y0 E1'
].join('\n');

describe('calibration G-code checks', () => {
	it('reads the pressure advance overrides only', () => {
		expect(paOverrides(gcode)).toEqual([0, 0.002]);
	});
	it('reads layer temperatures with repeats folded', () => {
		expect(layerTemperatures(gcode)).toEqual([230, 225]);
	});
	it('reads retraction lengths', () => {
		expect(retractionLengths(gcode)).toEqual([0, 0.1]);
	});
	it('finds the fastest feed rate per millimetre of height', () => {
		expect([...speedsByHeight(gcode)]).toEqual([
			[0, 50],
			[1, 100]
		]);
	});
	it('measures extrusion per millimetre per object on one feature', () => {
		const flows = flowByObject(gcode, 'Outer wall');
		expect(flows.get('7')).toBeCloseTo(0.05, 6);
		expect(flows.get('9')).toBeCloseTo(0.06, 6);
		expect(flowByObject(gcode, 'Outer wall', 0).get('7')).toBeCloseTo(0.05, 6);
		expect(flowByObject(gcode, 'Sparse infill').get('9')).toBeCloseTo(0.2, 6);
	});
});
