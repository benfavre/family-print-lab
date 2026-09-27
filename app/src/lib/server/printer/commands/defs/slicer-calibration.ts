// The printer's own calibration (slicer-calibration; Bambu Studio's device tab): flow dynamics
// (pressure advance) calibration and its K-value profiles per filament and nozzle, and flow rate
// calibration. Payloads as Bambu Studio v02.08.02.61 builds them in src/slic3r/GUI/DeviceManager.cpp
// (https://github.com/bambulab/BambuStudio at 926a719): command_start_pa_calibration ~1930,
// command_set_pa_calibration ~1971, command_delete_pa_calibration ~2012,
// command_get_pa_calibration_tab ~2031, command_get_pa_calibration_result ~2051,
// commnad_select_pa_calibration ~2061, command_start_flow_ratio_calibration ~2080 and
// command_get_flow_ratio_calibration_result ~2124. Floats go as text the way std::to_string writes
// them (six decimals) where Bambu Studio sends text; replies are read in shared/slicer-calibration.ts
// (DevCalib.cpp). Offered only when the printer reports the feature (flags.ts bits 6 and 7, Bambu
// Studio DeviceManager.cpp ~4438), and never during a print.
import { z } from 'zod';
import { defineCommand, type CommandContext } from '../registry';
import { amsSlotOf } from '../../report';
import { ACTIVE_PRINTER_STATES, type GlobalTray } from '$lib/shared/printers/status';
import {
	nozzleDiameterText,
	nozzleId,
	paCalibrationReason,
	flowCalibrationReason,
	type NozzleVolume
} from '$lib/shared/slicer-calibration';

const tray = z.number().int().min(0).max(255);
const diameter = z
	.number()
	.refine((d) => nozzleDiameterText(d) !== '0', 'Not a Bambu nozzle size.');
const volume = z.enum(['standard', 'high_flow', 'tpu_high_flow', 'e3d_high_flow']);
const filamentId = z.string().max(40);
const settingId = z.string().max(80);

export interface PaStartFilament {
	tray: GlobalTray;
	extruderId: number;
	bedTemp: number;
	nozzleTemp: number;
	filamentId: string;
	settingId: string;
	nozzleVolume: NozzleVolume;
	/** The nozzle this tray feeds, when it differs from the first (dual-nozzle printers). */
	nozzleDiameter?: number;
	maxVolumetricSpeed: number;
}
export interface PaStartParams {
	nozzleDiameter: number;
	/** Bambu Studio sends its calibration mode (0 automatic). */
	mode: number;
	filaments: PaStartFilament[];
}
export interface KProfileSet {
	tray: GlobalTray | null;
	caliIdx: number | null;
	extruderId: number;
	nozzleVolume: NozzleVolume;
	filamentId: string;
	settingId: string;
	name: string;
	kValue: number;
	/** An automatic calibration result's own n_coef (Bambu Studio saves those with is_auto_cali). */
	nCoef?: number;
}
export interface FlowStartFilament {
	tray: GlobalTray;
	extruderId: number;
	bedTemp: number;
	nozzleTemp: number;
	filamentId: string;
	settingId: string;
	flowRatio: number;
	maxVolumetricSpeed: number;
}

declare module '../registry' {
	interface CommandMap {
		'print.extrusion_cali': PaStartParams;
		'print.extrusion_cali_get': {
			nozzleDiameter: number;
			filamentId?: string;
			extruderId?: number;
			nozzleVolume?: NozzleVolume;
		};
		'print.extrusion_cali_get_result': { nozzleDiameter: number };
		'print.extrusion_cali_set': { nozzleDiameter: number; profiles: KProfileSet[] };
		'print.extrusion_cali_sel': {
			tray: GlobalTray;
			caliIdx: number;
			filamentId: string;
			nozzleDiameter: number;
		};
		'print.extrusion_cali_del': {
			caliIdx: number;
			extruderId: number;
			nozzleVolume: NozzleVolume;
			filamentId: string;
			nozzleDiameter: number;
		};
		'print.flowrate_cali': { nozzleDiameter: number; filaments: FlowStartFilament[] };
		'print.flowrate_get_result': { nozzleDiameter: number };
	}
}

/** std::to_string(float): six decimals. */
const f6 = (n: number) => n.toFixed(6);

const busy = (ctx: CommandContext) =>
	ctx.status && ACTIVE_PRINTER_STATES.has(ctx.status.gcodeState)
		? 'Wait until the print is over.'
		: null;
const paGuard = (ctx: CommandContext) => paCalibrationReason(ctx.caps, ctx.status);
const flowGuard = (ctx: CommandContext) => flowCalibrationReason(ctx.caps, ctx.status);

const source = (fn: string) =>
	`Bambu Studio v02.08.02.61 DeviceManager.cpp ${fn}; replies DeviceCore/DevCalib.cpp`;

export default [
	defineCommand({
		name: 'print.extrusion_cali',
		topic: 'print',
		source: source('command_start_pa_calibration'),
		params: z.strictObject({
			nozzleDiameter: diameter,
			mode: z.number().int().min(0).max(10),
			filaments: z
				.array(
					z.strictObject({
						tray,
						extruderId: z.number().int().min(0).max(1),
						bedTemp: z.number().int().min(0).max(130),
						nozzleTemp: z.number().int().min(150).max(350),
						filamentId,
						settingId,
						nozzleVolume: volume,
						nozzleDiameter: diameter.optional(),
						maxVolumetricSpeed: z.number().positive().max(100)
					})
				)
				.min(1)
				.max(16)
		}),
		guard: (ctx) => paGuard(ctx) ?? busy(ctx),
		// The top-level diameter is the first filament's; each filament names its own nozzle.
		build: (p) => ({
			command: 'extrusion_cali',
			nozzle_diameter: nozzleDiameterText(p.nozzleDiameter),
			mode: p.mode,
			filaments: p.filaments.map((f) => ({
				tray_id: f.tray,
				extruder_id: f.extruderId,
				bed_temp: f.bedTemp,
				filament_id: f.filamentId,
				setting_id: f.settingId,
				nozzle_temp: f.nozzleTemp,
				...amsSlotOf(f.tray),
				nozzle_id: nozzleId(f.nozzleVolume, f.nozzleDiameter ?? p.nozzleDiameter),
				nozzle_diameter: nozzleDiameterText(f.nozzleDiameter ?? p.nozzleDiameter),
				max_volumetric_speed: f6(f.maxVolumetricSpeed)
			}))
		}),
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.extrusion_cali_get',
		topic: 'print',
		source: source('command_get_pa_calibration_tab'),
		params: z.strictObject({
			nozzleDiameter: diameter,
			filamentId: filamentId.optional(),
			extruderId: z.number().int().min(0).max(1).optional(),
			nozzleVolume: volume.optional()
		}),
		guard: paGuard,
		build: (p) => ({
			command: 'extrusion_cali_get',
			filament_id: p.filamentId ?? '',
			...(p.extruderId !== undefined ? { extruder_id: p.extruderId } : {}),
			...(p.nozzleVolume ? { nozzle_id: nozzleId(p.nozzleVolume, p.nozzleDiameter) } : {}),
			nozzle_diameter: nozzleDiameterText(p.nozzleDiameter)
		}),
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.extrusion_cali_get_result',
		topic: 'print',
		source: source('command_get_pa_calibration_result'),
		params: z.strictObject({ nozzleDiameter: diameter }),
		guard: paGuard,
		build: (p) => ({
			command: 'extrusion_cali_get_result',
			nozzle_diameter: nozzleDiameterText(p.nozzleDiameter)
		}),
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.extrusion_cali_set',
		topic: 'print',
		source: source('command_set_pa_calibration'),
		params: z.strictObject({
			nozzleDiameter: diameter,
			profiles: z
				.array(
					z.strictObject({
						tray: tray.nullable(),
						caliIdx: z.number().int().min(-1).nullable(),
						extruderId: z.number().int().min(0).max(1),
						nozzleVolume: volume,
						filamentId,
						settingId,
						name: z.string().trim().min(1).max(40),
						kValue: z.number().min(0).max(10),
						nCoef: z.number().min(0).max(10).optional()
					})
				)
				.min(1)
				.max(16)
		}),
		guard: (ctx) => paGuard(ctx) ?? busy(ctx),
		build: (p) => ({
			command: 'extrusion_cali_set',
			nozzle_diameter: nozzleDiameterText(p.nozzleDiameter),
			filaments: p.profiles.map((k) => ({
				// Bambu Studio writes tray_id -1 for a profile not tied to a tray (manual results).
				tray_id: k.tray ?? -1,
				...(k.caliIdx !== null && k.caliIdx >= 0 ? { cali_idx: k.caliIdx } : {}),
				extruder_id: k.extruderId,
				nozzle_id: nozzleId(k.nozzleVolume, p.nozzleDiameter),
				nozzle_diameter: nozzleDiameterText(p.nozzleDiameter),
				...(k.tray !== null ? amsSlotOf(k.tray) : { ams_id: 0, slot_id: 0 }),
				filament_id: k.filamentId,
				setting_id: k.settingId,
				name: k.name,
				k_value: f6(k.kValue),
				// Manual results send "0.0"; automatic results keep their own n_coef (CalibrationWizard.cpp
				// ~1023 calls set_PA_calib_result with is_auto_cali for those).
				n_coef: k.nCoef !== undefined ? f6(k.nCoef) : '0.0'
			}))
		}),
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.extrusion_cali_sel',
		topic: 'print',
		source: source('commnad_select_pa_calibration'),
		params: z.strictObject({
			tray,
			caliIdx: z.number().int().min(-1),
			filamentId,
			nozzleDiameter: diameter
		}),
		guard: (ctx) => paGuard(ctx) ?? busy(ctx),
		build: (p) => ({
			command: 'extrusion_cali_sel',
			tray_id: p.tray,
			...amsSlotOf(p.tray),
			cali_idx: p.caliIdx,
			filament_id: p.filamentId,
			nozzle_diameter: nozzleDiameterText(p.nozzleDiameter)
		}),
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.extrusion_cali_del',
		topic: 'print',
		source: source('command_delete_pa_calibration'),
		params: z.strictObject({
			caliIdx: z.number().int().min(0),
			extruderId: z.number().int().min(0).max(1),
			nozzleVolume: volume,
			filamentId,
			nozzleDiameter: diameter
		}),
		guard: (ctx) => paGuard(ctx) ?? busy(ctx),
		build: (p) => ({
			command: 'extrusion_cali_del',
			extruder_id: p.extruderId,
			nozzle_id: nozzleId(p.nozzleVolume, p.nozzleDiameter),
			filament_id: p.filamentId,
			cali_idx: p.caliIdx,
			nozzle_diameter: nozzleDiameterText(p.nozzleDiameter)
		}),
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.flowrate_cali',
		topic: 'print',
		source: source('command_start_flow_ratio_calibration'),
		params: z.strictObject({
			nozzleDiameter: diameter,
			filaments: z
				.array(
					z.strictObject({
						tray,
						extruderId: z.number().int().min(0).max(1),
						bedTemp: z.number().int().min(0).max(130),
						nozzleTemp: z.number().int().min(150).max(350),
						filamentId,
						settingId,
						flowRatio: z.number().min(0.5).max(1.5),
						maxVolumetricSpeed: z.number().positive().max(100)
					})
				)
				.min(1)
				.max(16)
		}),
		guard: (ctx) => flowGuard(ctx) ?? busy(ctx),
		build: (p) => ({
			command: 'flowrate_cali',
			tray_id: p.filaments[0].tray,
			nozzle_diameter: nozzleDiameterText(p.nozzleDiameter),
			filaments: p.filaments.map((f) => ({
				tray_id: f.tray,
				bed_temp: f.bedTemp,
				filament_id: f.filamentId,
				setting_id: f.settingId,
				nozzle_temp: f.nozzleTemp,
				def_flow_ratio: f6(f.flowRatio),
				max_volumetric_speed: f6(f.maxVolumetricSpeed),
				extruder_id: f.extruderId,
				...amsSlotOf(f.tray)
			}))
		}),
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.flowrate_get_result',
		topic: 'print',
		source: source('command_get_flow_ratio_calibration_result'),
		params: z.strictObject({ nozzleDiameter: diameter }),
		guard: flowGuard,
		build: (p) => ({
			command: 'flowrate_get_result',
			nozzle_diameter: nozzleDiameterText(p.nozzleDiameter)
		}),
		risk: 'safe'
	})
];
