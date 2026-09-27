import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeReport, parseReport, parseVersions } from '../../report';
import { flowCalibrationReason } from '$lib/shared/slicer-calibration';
import { commandDef, type CommandContext, type CommandName } from '../registry';
import { PRINTER_MODELS, capabilitiesFor, type ModelCode } from '$lib/shared/printers/models';
import { emptySnapshot, type PrinterSnapshot } from '$lib/shared/printers/status';
import { parse } from '../../../validation';

const ctx = (
	model: ModelCode = 'BL-P001',
	status: Partial<PrinterSnapshot> = {
		firmwareSupport: { paCalibration: true, flowCalibration: true }
	}
): CommandContext => ({
	printerId: 'p',
	model: PRINTER_MODELS[model],
	caps: capabilitiesFor(model, null),
	status: emptySnapshot(status),
	firmware: null
});
function payload(name: CommandName, params: unknown) {
	const def = commandDef(name)!;
	return def.build(parse(def.params, params) as never, ctx());
}
const guard = (name: CommandName, params: unknown, c = ctx()) => {
	const def = commandDef(name)!;
	return def.guard?.(c, parse(def.params, params) as never) ?? null;
};

// Payloads as Bambu Studio v02.08.02.61 DeviceManager.cpp builds them (the functions named per test).
describe('printer calibration commands', () => {
	it('starts flow dynamics calibration like command_start_pa_calibration', () => {
		expect(
			payload('print.extrusion_cali', {
				nozzleDiameter: 0.4,
				mode: 0,
				filaments: [
					{
						tray: 5,
						extruderId: 0,
						bedTemp: 55,
						nozzleTemp: 220,
						filamentId: 'GFA00',
						settingId: 'GFSA00',
						nozzleVolume: 'high_flow',
						maxVolumetricSpeed: 21
					}
				]
			})
		).toEqual({
			command: 'extrusion_cali',
			nozzle_diameter: '0.4',
			mode: 0,
			filaments: [
				{
					tray_id: 5,
					extruder_id: 0,
					bed_temp: 55,
					filament_id: 'GFA00',
					setting_id: 'GFSA00',
					nozzle_temp: 220,
					ams_id: 1,
					slot_id: 1,
					nozzle_id: 'HH00-0.4',
					nozzle_diameter: '0.4',
					max_volumetric_speed: '21.000000'
				}
			]
		});
	});

	it('names each filament’s own nozzle on a dual-nozzle printer (per calib_datas[i])', () => {
		const body = payload('print.extrusion_cali', {
			nozzleDiameter: 0.4,
			mode: 0,
			filaments: [
				{
					tray: 0,
					extruderId: 1,
					bedTemp: 55,
					nozzleTemp: 220,
					filamentId: 'GFA00',
					settingId: 'GFSA00',
					nozzleVolume: 'standard',
					maxVolumetricSpeed: 21
				},
				{
					tray: 4,
					extruderId: 0,
					bedTemp: 55,
					nozzleTemp: 220,
					filamentId: 'GFA00',
					settingId: 'GFSA00',
					nozzleVolume: 'high_flow',
					nozzleDiameter: 0.6,
					maxVolumetricSpeed: 21
				}
			]
		}) as { nozzle_diameter: string; filaments: Record<string, unknown>[] };
		expect(body.nozzle_diameter).toBe('0.4');
		expect(body.filaments.map((f) => [f.extruder_id, f.nozzle_id, f.nozzle_diameter])).toEqual([
			[1, 'HS00-0.4', '0.4'],
			[0, 'HH00-0.6', '0.6']
		]);
	});

	it('asks for the K profiles like command_get_pa_calibration_tab and the result', () => {
		expect(
			payload('print.extrusion_cali_get', { nozzleDiameter: 0.6, filamentId: 'GFA00' })
		).toEqual({
			command: 'extrusion_cali_get',
			filament_id: 'GFA00',
			nozzle_diameter: '0.6'
		});
		expect(
			payload('print.extrusion_cali_get', {
				nozzleDiameter: 0.4,
				extruderId: 1,
				nozzleVolume: 'standard'
			})
		).toEqual({
			command: 'extrusion_cali_get',
			filament_id: '',
			extruder_id: 1,
			nozzle_id: 'HS00-0.4',
			nozzle_diameter: '0.4'
		});
		expect(payload('print.extrusion_cali_get_result', { nozzleDiameter: 0.2 })).toEqual({
			command: 'extrusion_cali_get_result',
			nozzle_diameter: '0.2'
		});
	});

	it('saves, picks and deletes profiles like command_set/select/delete_pa_calibration', () => {
		expect(
			payload('print.extrusion_cali_set', {
				nozzleDiameter: 0.4,
				profiles: [
					{
						tray: null,
						caliIdx: null,
						extruderId: 0,
						nozzleVolume: 'standard',
						filamentId: 'GFA00',
						settingId: '',
						name: 'PLA from the tower',
						kValue: 0.025
					}
				]
			})
		).toEqual({
			command: 'extrusion_cali_set',
			nozzle_diameter: '0.4',
			filaments: [
				{
					tray_id: -1,
					extruder_id: 0,
					nozzle_id: 'HS00-0.4',
					nozzle_diameter: '0.4',
					ams_id: 0,
					slot_id: 0,
					filament_id: 'GFA00',
					setting_id: '',
					name: 'PLA from the tower',
					k_value: '0.025000',
					n_coef: '0.0'
				}
			]
		});
		const replace = payload('print.extrusion_cali_set', {
			nozzleDiameter: 0.4,
			profiles: [
				{
					tray: 255,
					caliIdx: 7,
					extruderId: 0,
					nozzleVolume: 'standard',
					filamentId: 'GFA00',
					settingId: '',
					name: 'x',
					kValue: 0.02
				}
			]
		}) as { filaments: Record<string, unknown>[] };
		expect(replace.filaments[0]).toMatchObject({
			tray_id: 255,
			cali_idx: 7,
			ams_id: 255,
			slot_id: 0
		});
		// An automatic result keeps its n_coef (set_PA_calib_result with is_auto_cali).
		const auto = payload('print.extrusion_cali_set', {
			nozzleDiameter: 0.4,
			profiles: [
				{
					tray: 1,
					caliIdx: null,
					extruderId: 0,
					nozzleVolume: 'standard',
					filamentId: 'GFA00',
					settingId: 'GFSA00',
					name: 'Auto',
					kValue: 0.024,
					nCoef: 1.4
				}
			]
		}) as { filaments: Record<string, unknown>[] };
		expect(auto.filaments[0]).toMatchObject({ k_value: '0.024000', n_coef: '1.400000' });
		expect(
			payload('print.extrusion_cali_sel', {
				tray: 2,
				caliIdx: 7,
				filamentId: 'GFA00',
				nozzleDiameter: 0.4
			})
		).toEqual({
			command: 'extrusion_cali_sel',
			tray_id: 2,
			ams_id: 0,
			slot_id: 2,
			cali_idx: 7,
			filament_id: 'GFA00',
			nozzle_diameter: '0.4'
		});
		expect(
			payload('print.extrusion_cali_del', {
				caliIdx: 7,
				extruderId: 0,
				nozzleVolume: 'high_flow',
				filamentId: 'GFA00',
				nozzleDiameter: 0.4
			})
		).toEqual({
			command: 'extrusion_cali_del',
			extruder_id: 0,
			nozzle_id: 'HH00-0.4',
			filament_id: 'GFA00',
			cali_idx: 7,
			nozzle_diameter: '0.4'
		});
	});

	it('starts flow rate calibration like command_start_flow_ratio_calibration', () => {
		expect(
			payload('print.flowrate_cali', {
				nozzleDiameter: 0.4,
				filaments: [
					{
						tray: 254,
						extruderId: 1,
						bedTemp: 65,
						nozzleTemp: 250,
						filamentId: 'GFG02',
						settingId: 'GFSG02',
						flowRatio: 0.95,
						maxVolumetricSpeed: 16
					}
				]
			})
		).toEqual({
			command: 'flowrate_cali',
			tray_id: 254,
			nozzle_diameter: '0.4',
			filaments: [
				{
					tray_id: 254,
					bed_temp: 65,
					filament_id: 'GFG02',
					setting_id: 'GFSG02',
					nozzle_temp: 250,
					def_flow_ratio: '0.950000',
					max_volumetric_speed: '16.000000',
					extruder_id: 1,
					ams_id: 254,
					slot_id: 0
				}
			]
		});
		expect(payload('print.flowrate_get_result', { nozzleDiameter: 0.4 })).toEqual({
			command: 'flowrate_get_result',
			nozzle_diameter: '0.4'
		});
	});

	it('refuses printers without the feature, prints in progress and odd nozzles', () => {
		const off = ctx('BL-P001', {
			firmwareSupport: { paCalibration: false, flowCalibration: false }
		});
		expect(guard('print.extrusion_cali_get', { nozzleDiameter: 0.4 }, off)).toMatch(
			/flow dynamics/
		);
		expect(guard('print.flowrate_get_result', { nozzleDiameter: 0.4 }, off)).toMatch(/flow rate/);
		const printing = ctx('BL-P001', {
			gcodeState: 'RUNNING',
			firmwareSupport: { paCalibration: true, flowCalibration: true }
		});
		expect(
			guard(
				'print.extrusion_cali_sel',
				{ tray: 0, caliIdx: 1, filamentId: 'GFA00', nozzleDiameter: 0.4 },
				printing
			)
		).toMatch(/print is over/);
		expect(guard('print.extrusion_cali_get', { nozzleDiameter: 0.4 }, printing)).toBeNull();
		expect(() => payload('print.extrusion_cali_get_result', { nozzleDiameter: 0.5 })).toThrow(
			/nozzle size/
		);
	});

	it('refuses flow rate calibration on the H2D although its report sets the bit (Bambu Studio)', () => {
		const f = JSON.parse(
			fs.readFileSync(path.join(import.meta.dirname, '../../__fixtures__/reports/h2d.json'), 'utf8')
		);
		const model = PRINTER_MODELS.O1D;
		const snap = parseReport(mergeReport({}, structuredClone(f.pushall)), {
			model,
			versions: parseVersions(f.get_version),
			accessCodeSet: true
		});
		expect(snap.firmwareSupport.flowCalibration).toBe(true);
		const caps = capabilitiesFor('O1D', null);
		expect(flowCalibrationReason(caps, snap, model.series)).toBe(
			'This printer does not do flow rate calibration itself.'
		);
		const c: CommandContext = { printerId: 'p', model, caps, status: snap, firmware: null };
		expect(
			guard(
				'print.flowrate_cali',
				{
					nozzleDiameter: 0.4,
					filaments: [
						{
							tray: 0,
							extruderId: 0,
							bedTemp: 55,
							nozzleTemp: 220,
							filamentId: 'GFA00',
							settingId: 'GFSA00',
							flowRatio: 0.98,
							maxVolumetricSpeed: 21
						}
					]
				},
				c
			)
		).toMatch(/flow rate/);
	});
});
