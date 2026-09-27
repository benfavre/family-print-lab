import { describe, expect, it } from 'vitest';
import {
	CALIB_KINDS,
	CALIB_TESTS,
	calibChanges,
	calibDefaults,
	calibProblem,
	flowCalibrationReason,
	nozzleDiameterText,
	nozzleId,
	nozzleVolumeOf,
	paCalibrationReason,
	parseFlowResults,
	parseKProfiles,
	roundSetting,
	volumetricAtHeight
} from './slicer-calibration';

describe('calibration tests', () => {
	it('has a description, reading steps and valid defaults for every test', () => {
		for (const kind of CALIB_KINDS) {
			const t = CALIB_TESTS[kind];
			expect(t.kind).toBe(kind);
			expect(t.read.length).toBeGreaterThan(0);
			expect(calibProblem(kind, calibDefaults(kind))).toBeNull();
			expect(
				calibProblem(kind, calibDefaults(kind, { bowden: true, material: 'PETG' }))
			).toBeNull();
		}
	});

	it('offers Bambu Studio’s starting values', () => {
		expect(calibDefaults('pa_line')).toEqual({
			start: 0,
			end: 0.1,
			step: 0.002,
			printNumbers: true
		});
		expect(calibDefaults('pa_pattern', { bowden: true })).toEqual({ start: 0, end: 1, step: 0.05 });
		expect(calibDefaults('temp_tower', { material: 'PETG HF' })).toEqual({
			start: 250,
			end: 230,
			step: 5
		});
		expect(calibDefaults('temp_tower', { material: 'ABS' }).start).toBe(270);
		expect(calibDefaults('temp_tower', { material: 'PLA Matte' }).start).toBe(230);
		expect(calibDefaults('max_volumetric')).toEqual({ start: 5, end: 20, step: 0.5 });
		expect(calibDefaults('vfa')).toEqual({ start: 40, end: 200, step: 10 });
		expect(calibDefaults('retraction')).toEqual({ start: 0, end: 2, step: 0.1 });
	});

	it('explains ranges that cannot make a test', () => {
		expect(calibProblem('temp_tower', { start: 360, end: 300, step: 5 })).toMatch(/350/);
		expect(calibProblem('temp_tower', { start: 200, end: 200, step: 5 })).toMatch(/5 °C/);
		expect(calibProblem('pa_line', { start: 0, end: 1, step: 0.001 })).toMatch(/60 lines/);
		expect(calibProblem('pa_tower', { start: 0.1, end: 0.05, step: 0.01 })).toMatch(/end/);
		expect(calibProblem('vfa', { start: 10, end: 100, step: 10 })).toMatch(/10 mm\/s/);
		expect(calibProblem('max_volumetric', { start: 5, end: 5.2, step: 0.5 })).toMatch(
			/start \+ step/
		);
		expect(calibProblem('retraction', { start: 0 })).toMatch(/Enter/);
		expect(calibProblem('flow_rate', { pass: 3 as 1 })).toMatch(/pass/);
	});

	it('turns a result into filament preset keys', () => {
		expect(calibChanges('flow_rate', 0.95123)).toEqual({ filament_flow_ratio: ['0.951'] });
		expect(calibChanges('pa_pattern', 0.025)).toEqual({
			pressure_advance: ['0.025'],
			enable_pressure_advance: ['1']
		});
		expect(calibChanges('temp_tower', 215)).toEqual({ nozzle_temperature: ['215'] });
		expect(calibChanges('retraction', 0.8)).toEqual({ filament_retraction_length: ['0.8'] });
		expect(calibChanges('max_volumetric', 18.26)).toEqual({
			filament_max_volumetric_speed: ['18.3']
		});
		expect(calibChanges('vfa', 120)).toEqual({});
		expect(roundSetting('pressure_advance', 0.0204)).toBe(0.02);
	});

	it('works out max volumetric speed from the height where the vase failed', () => {
		expect(volumetricAtHeight({ start: 5, step: 0.5 }, 21)).toBe(15.5);
		expect(volumetricAtHeight({ start: 2, step: 0.25 }, 10.3)).toBe(4.6);
	});
});

describe('the printer’s own calibration', () => {
	it('names nozzles as Bambu Studio does', () => {
		expect(nozzleDiameterText(0.4)).toBe('0.4');
		expect(nozzleDiameterText(0.6000001)).toBe('0.6');
		expect(nozzleDiameterText(0.5)).toBe('0');
		expect(nozzleId('standard', 0.4)).toBe('HS00-0.4');
		expect(nozzleId('high_flow', 0.6)).toBe('HH00-0.6');
		expect(nozzleId('tpu_high_flow', 0.4)).toBe('HU00-0.4');
		expect(nozzleVolumeOf('HH00-0.4')).toBe('high_flow');
		expect(nozzleVolumeOf('HB00-0.4')).toBe('e3d_high_flow');
		expect(nozzleVolumeOf('xx')).toBe('standard');
	});

	it('gates on the feature bits, else the model', () => {
		const status = (pa?: boolean, flow?: boolean) => ({
			firmwareSupport: { paCalibration: pa, flowCalibration: flow }
		});
		expect(paCalibrationReason({ flowCalibration: false }, status(true))).toBeNull();
		expect(paCalibrationReason({ flowCalibration: true }, status(false))).toMatch(/does not/);
		expect(paCalibrationReason({ flowCalibration: true }, status())).toBeNull();
		expect(paCalibrationReason({ flowCalibration: false }, null)).toMatch(/does not/);
		expect(flowCalibrationReason({ flowCalibration: false }, status(undefined, true))).toBeNull();
	});

	it('reads K-value profiles as Bambu Studio does', () => {
		const list = parseKProfiles({
			nozzle_diameter: '0.4',
			filaments: [
				{
					cali_idx: 3,
					name: 'PLA fast',
					k_value: '0.024000',
					n_coef: 0,
					filament_id: 'GFA00',
					setting_id: 'GFSA00',
					extruder_id: 0,
					nozzle_id: 'HH00-0.4'
				},
				{ cali_idx: 4, k_value: 12, filament_id: 'GFA01' },
				{ k_value: '0.05', nozzle_diameter: 0.6, tray_id: 2, confidence: 1 }
			]
		});
		expect(list).toHaveLength(2);
		expect(list[0]).toMatchObject({
			caliIdx: 3,
			name: 'PLA fast',
			kValue: 0.024,
			nozzleId: 'HH00-0.4',
			nozzleDiameter: 0.4
		});
		expect(list[1]).toMatchObject({ caliIdx: -1, nozzleDiameter: 0.6, trayId: 2, confidence: 1 });
		expect(parseKProfiles(undefined)).toEqual([]);
	});

	it('reads flow rate results', () => {
		expect(
			parseFlowResults({
				filaments: [
					{ tray_id: 1, nozzle_diameter: '0.4', filament_id: 'GFA00', flow_ratio: '0.951000' }
				]
			})
		).toEqual([
			{
				trayId: 1,
				nozzleDiameter: 0.4,
				filamentId: 'GFA00',
				settingId: '',
				flowRatio: 0.951,
				confidence: 0
			}
		]);
	});
});
