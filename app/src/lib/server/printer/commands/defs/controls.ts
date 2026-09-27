// Printer controls (the controls package): speed, lights, temperatures, fans, airduct, home, jog,
// extruder, active nozzle, buzzer, AMS load/unload, calibration, skip objects, print options, AI
// detectors and guarded custom G-code. Where Bambu Studio has a dedicated MQTT command it uses it only
// when the printer says it supports it (feature bits in `fun`, dual nozzles, the airduct) and falls back
// to G-code otherwise; these defs make the same choice in build(). Payloads verified against Bambu Studio
// v02.08.02.61 (https://github.com/bambulab/BambuStudio, files named per def), ha-bambulab
// pybambu/commands.py and utils.py (https://github.com/greghesp/ha-bambulab at 0e027ff) and OpenBambuAPI
// mqtt.md (https://github.com/Doridian/OpenBambuAPI at cc383a2), and exercised against the simulator.
import { z } from 'zod';
import { defineCommand, type CommandContext } from '../registry';
import { amsSlotOf } from '../../report';
import {
	EXT_DEPUTY,
	EXT_MAIN,
	type GlobalTray,
	type PrinterTray,
	type SpeedLevel
} from '$lib/shared/printers/status';
import {
	amsLoadReason,
	airductReason,
	bedSlinger,
	buzzerReason,
	calibrationReason,
	detectorReason,
	dualNozzle,
	extrudeReason,
	fanReason,
	GCODE_MAX_LINE,
	GCODE_MAX_LINES,
	gcodeReason,
	homeReason,
	jogReason,
	lightReason,
	newFanProtocol,
	newProtocol,
	selectNozzleReason,
	skipReason,
	speedReason,
	tempReason,
	type Axis,
	type CalibrationChoice,
	type ControlTarget,
	type Detector,
	type DoorCheck,
	type FanName,
	type HaltSensitivity,
	type LightNode,
	type PrintOptionName
} from '$lib/shared/controls';

declare module '../registry' {
	interface CommandMap {
		'print.print_speed': { level: SpeedLevel };
		'system.ledctrl': { node: LightNode; mode: 'on' | 'off' };
		'print.set_nozzle_temp': { temp: number; nozzle?: 0 | 1 };
		'print.set_bed_temp': { temp: number };
		'print.set_ctt': { temp: number };
		'print.set_fan': { fan: FanName; percent: number };
		'print.set_airduct': { mode: number };
		'print.back_to_center': Record<string, never>;
		'print.xyz_ctrl': { axis: Axis; distance: number };
		'print.set_extrusion_length': { length: number; nozzle?: 0 | 1 };
		'print.select_extruder': { nozzle: 0 | 1 };
		'print.buzzer_ctrl': { mode: 0 | 1 | 2 };
		'print.ams_change_filament': { tray: GlobalTray };
		'print.ams_change_filament:unload': Record<string, never>;
		'print.ams_control': { action: 'resume' | 'done' };
		'print.calibration': CalibrationChoice;
		'print.skip_objects': { ids: number[] };
		'print.print_option': { option: PrintOptionName; enabled: boolean };
		'xcam.xcam_control_set': {
			detector: Detector;
			enabled: boolean;
			sensitivity?: HaltSensitivity;
		};
		'print.gcode_line:custom': { lines: string[] };
		'system.set_door_stat': { mode: DoorCheck };
	}
}

const none = z.strictObject({}) as unknown as z.ZodType<Record<string, never>>;
const target = (ctx: CommandContext): ControlTarget => ctx;
const gcode = (lines: string) => ({ command: 'gcode_line', param: lines });

/** Midpoint of a tray's nozzle range, or -1 when unknown (Bambu Studio StatusPanel.cpp on_ams_load_curr ~4940). */
const midTemp = (t: PrinterTray | undefined) =>
	t?.tempMin && t.tempMax ? Math.floor((t.tempMin + t.tempMax) / 2) : -1;

function trayOf(ctx: CommandContext, global: GlobalTray | null): PrinterTray | undefined {
	if (global === null) return undefined;
	const s = ctx.status;
	return [...(s?.ams ?? []).flatMap((u) => u.trays), ...(s?.externalSpools ?? [])].find(
		(t) => t.global === global
	);
}

/** Fan part ids: Bambu Studio DeviceCore/DevFan.h AIR_FUN (the airduct part `id` >> 4); the same numbers are M106's P (ha-bambulab utils.fan_percentage_to_gcode). */
const FAN_INDEX: Record<FanName, number> = { part: 1, aux: 2, chamber: 3, secondaryAux: 10 };

/** calibration `option` bits (Bambu Studio DeviceManager.cpp command_start_calibration ~1906). */
const CALIBRATION_BITS: Record<keyof CalibrationChoice, number> = {
	lidar: 1 << 0,
	bedLeveling: 1 << 1,
	vibration: 1 << 2,
	motorNoise: 1 << 3
};

const temp = z.number().int().min(0).max(500);
const nozzleId = z.union([z.literal(0), z.literal(1)]);

export default [
	defineCommand({
		name: 'print.print_speed',
		topic: 'print',
		source:
			'OpenBambuAPI mqtt.md "print.print_speed"; Bambu Studio DeviceManager.cpp command_set_printing_speed ~1835 (param is the level as a string)',
		params: z.strictObject({
			level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
		}),
		guard: (ctx) => speedReason(target(ctx)),
		build: (o) => ({ command: 'print_speed', param: String(o.level) }),
		settled: (s, o) => s.speed.level === o.level,
		risk: 'safe'
	}),
	defineCommand({
		name: 'system.ledctrl',
		topic: 'system',
		source:
			'OpenBambuAPI mqtt.md "system.ledctrl" (all timing fields always present); ha-bambulab commands.py CHAMBER_LIGHT_*, CHAMBER_LIGHT_2_*, HEATBED_LIGHT_* templates',
		params: z.strictObject({
			node: z.enum(['chamber_light', 'chamber_light2', 'work_light', 'heatbed_light']),
			mode: z.enum(['on', 'off'])
		}),
		guard: (ctx, o) => lightReason(target(ctx), o.node),
		build: (o) => ({
			command: 'ledctrl',
			led_node: o.node,
			led_mode: o.mode,
			// The bed light template has no flashing timings; the others use 500 ms like ha-bambulab.
			led_on_time: o.node === 'heatbed_light' ? 0 : 500,
			led_off_time: o.node === 'heatbed_light' ? 0 : 500,
			loop_times: 0,
			interval_time: 0
		}),
		settled: (s, o) =>
			({
				chamber_light: s.lights.chamber,
				chamber_light2: s.lights.chamber2,
				work_light: s.lights.work,
				heatbed_light: s.lights.heatbed
			})[o.node] === o.mode,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.set_nozzle_temp',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_set_nozzle_new ~1611 (dual nozzle, QoS 1) and command_set_nozzle ~1596 (M104 S<t>), chosen as StatusPanel.cpp on_set_nozzle_temp ~4760 does',
		params: z.strictObject({ temp, nozzle: nozzleId.optional() }),
		guard: (ctx, o) => tempReason(target(ctx), 'nozzle', o.temp, o.nozzle ?? 0),
		build: (o, ctx) =>
			dualNozzle(target(ctx))
				? { command: 'set_nozzle_temp', extruder_index: o.nozzle ?? 0, target_temp: o.temp }
				: gcode(`M104 S${o.temp}\n`),
		settled: (s, o) =>
			(s.nozzles.find((n) => n.id === (o.nozzle ?? 0))?.target ?? s.nozzleTarget) === o.temp,
		// set_nozzle_temp goes out with QoS 1; the G-code form is fine with it too.
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.set_bed_temp',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_set_bed ~1571: set_bed_temp when m_support_mqtt_bet_ctrl (fun bit 39), else M140 S<t>',
		params: z.strictObject({ temp }),
		guard: (ctx, o) => tempReason(target(ctx), 'bed', o.temp),
		build: (o, ctx) =>
			ctx.status?.firmwareSupport.mqttBedTemp
				? { command: 'set_bed_temp', temp: o.temp }
				: gcode(`M140 S${o.temp}\n`),
		settled: (s, o) => s.bedTarget === o.temp,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.set_ctt',
		topic: 'print',
		source:
			'Bambu Studio DeviceCore/DevChamberCtrl.cpp CtrlSetChamberTemp (QoS 1), the only chamber path StatusPanel.cpp on_set_chamber_temp uses',
		params: z.strictObject({ temp }),
		requires: ['chamberTempEdit'],
		guard: (ctx, o) => tempReason(target(ctx), 'chamber', o.temp),
		build: (o) => ({ command: 'set_ctt', ctt_val: o.temp }),
		settled: (s, o) => s.chamberTarget === o.temp,
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.set_fan',
		topic: 'print',
		source:
			'Bambu Studio Widgets/FanControl.cpp FanControlNew::command_control_fan: DevFan.cpp command_control_fan_new (speed in %) with the new protocol and an airduct, else M106 P<id> S<floor(step*25.5)>; P10 for the second auxiliary fan per ha-bambulab utils.fan_percentage_to_gcode',
		params: z.strictObject({
			fan: z.enum(['part', 'aux', 'chamber', 'secondaryAux']),
			percent: z
				.number()
				.int()
				.min(0)
				.max(100)
				.refine((n) => n % 10 === 0, 'Fans move in 10 % steps.')
		}),
		guard: (ctx, o) => fanReason(target(ctx), o.fan),
		build: (o, ctx) =>
			newFanProtocol(ctx.status)
				? { command: 'set_fan', fan_index: FAN_INDEX[o.fan], speed: o.percent }
				: gcode(`M106 P${FAN_INDEX[o.fan]} S${Math.floor((o.percent / 10) * 25.5)} \n`),
		settled: (s, o) => s.fans[o.fan] === o.percent,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.set_airduct',
		topic: 'print',
		source:
			'Bambu Studio DeviceCore/DevFan.cpp command_control_air_duct; ha-bambulab commands.py AIRDUCT_SET_MODE_TEMPLATE (submode -1)',
		params: z.strictObject({ mode: z.number().int().min(0).max(3) }),
		requires: ['airductMode'],
		guard: (ctx) => airductReason(target(ctx)),
		build: (o) => ({ command: 'set_airduct', modeId: o.mode, submode: -1 }),
		settled: (s, o) => s.airductMode === o.mode,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.back_to_center',
		topic: 'print',
		source:
			'Bambu Studio DeviceCore/DevAxisCtrl.cpp Ctrl_GoHome: back_to_center when m_is_support_mqtt_homing (fun bit 32), else G28 (ha-bambulab commands.py HOME_GCODE); idle only here',
		params: none,
		guard: (ctx) => homeReason(target(ctx)),
		build: (_o, ctx) =>
			ctx.status?.firmwareSupport.mqttHoming ? { command: 'back_to_center' } : gcode('G28\n'),
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.xyz_ctrl',
		topic: 'print',
		source:
			'Bambu Studio DeviceCore/DevAxisCtrl.cpp Ctrl_Axis: xyz_ctrl {axis, dir, mode} when m_is_support_mqtt_axis_ctrl (fun bit 38), else the relative-move G-code (ha-bambulab MOVE_AXIS_GCODE); Y and Z inverted on i3 printers; speeds from StatusPanel.cpp (3000 XY, 900 Z)',
		params: z.strictObject({
			axis: z.enum(['X', 'Y', 'Z']),
			distance: z
				.number()
				.int()
				.refine((n) => [1, 10, 50].includes(Math.abs(n)), 'Steps are 1, 10 or 50 mm.')
		}),
		guard: (ctx, o) => jogReason(target(ctx), o.axis, o.distance),
		build: (o, ctx) => {
			const invert = bedSlinger(ctx.model) && (o.axis === 'Y' || o.axis === 'Z');
			const value = invert ? -o.distance : o.distance;
			if (ctx.status?.firmwareSupport.mqttAxis)
				return {
					command: 'xyz_ctrl',
					axis: o.axis,
					dir: value > 0 ? 1 : -1,
					mode: Math.abs(o.distance) >= 10 ? 1 : 0
				};
			const speed = o.axis === 'Z' ? 900 : 3000;
			return gcode(
				`M211 S \nM211 X1 Y1 Z1\nM1002 push_ref_mode\nG91 \nG1 ${o.axis}${value.toFixed(1)} F${speed}\nM1002 pop_ref_mode\nM211 R\n`
			);
		},
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.set_extrusion_length',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_extruder_control ~1884 with the new protocol, else DevAxisCtrl.cpp Ctrl_Axis("E") G-code (ha-bambulab EXTRUDER_GCODE); StatusPanel.cpp on_axis_ctrl_e_* (10 mm, above 170 °C)',
		params: z.strictObject({
			length: z.union([z.literal(10), z.literal(-10)]),
			nozzle: nozzleId.optional()
		}),
		guard: (ctx, o) => extrudeReason(target(ctx), o.nozzle),
		// Bambu Studio sends the extruder in use (GetCurrentExtder()->GetExtId()).
		build: (o, ctx) =>
			newProtocol(ctx.status)
				? {
						command: 'set_extrusion_length',
						extruder_index: o.nozzle ?? ctx.status?.activeNozzle ?? 0,
						length: o.length
					}
				: gcode(`M83 \nG0 E${o.length.toFixed(1)} F900\n`),
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.select_extruder',
		topic: 'print',
		source: 'Bambu Studio DeviceCore/DevCtrl.cpp command_select_extruder (QoS 1)',
		params: z.strictObject({ nozzle: nozzleId }),
		requires: ['dualNozzle'],
		guard: (ctx) => selectNozzleReason(target(ctx)),
		build: (o) => ({ command: 'select_extruder', extruder_index: o.nozzle }),
		settled: (s, o) => s.activeNozzle === o.nozzle,
		qos: 1,
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.buzzer_ctrl',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_stop_buzzer ~1561 (QoS 1); modes 0 silent, 1 alarm, 2 beeping per ha-bambulab commands.py BUZZER_SET_*',
		params: z.strictObject({ mode: z.union([z.literal(0), z.literal(1), z.literal(2)]) }),
		requires: ['fireAlarmBuzzer'],
		guard: (ctx) => buzzerReason(target(ctx)),
		// Silence is Studio's exact form; alarm and beeping only exist in ha-bambulab, with `reason`.
		build: (o) =>
			o.mode === 0
				? { command: 'buzzer_ctrl', mode: 0 }
				: { command: 'buzzer_ctrl', mode: o.mode, reason: '' },
		qos: 1,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.ams_change_filament',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_ams_change_filament ~1639 as StatusPanel.cpp on_ams_load_curr ~4890 calls it (external spool: its own id with the new protocol, else 254); temperatures are the trays’ midpoints; ha-bambulab coordinator.py _service_call_load_filament',
		params: z.strictObject({
			tray: z
				.number()
				.int()
				.refine(
					(t) =>
						(t >= 0 && t < 16) ||
						(t >= 24 && t <= 27) ||
						(t >= 128 && t <= 135) ||
						t === EXT_MAIN ||
						t === EXT_DEPUTY,
					'Not a filament tray.'
				)
		}),
		requires: ['amsSwitchCommand'],
		guard: (ctx, o) => {
			const refused = amsLoadReason(target(ctx));
			if (refused) return refused;
			const tray = trayOf(ctx, o.tray);
			if (ctx.status && !tray) return 'That tray is not on this printer.';
			if (tray && !tray.type) return 'That tray is empty.';
			return null;
		},
		build: (o, ctx) => {
			const external = o.tray === EXT_MAIN || o.tray === EXT_DEPUTY;
			const { ams_id, slot_id } = amsSlotOf(o.tray);
			const amsId = external && !newProtocol(ctx.status) ? EXT_DEPUTY : ams_id;
			// Bambu Studio: target = ams_id * 4 + slot for AMS units (ams_id < 16), else the ams id (tray
			// index 0 is special-cased the same way).
			const index = amsId < 16 ? amsId * 4 + slot_id : 0;
			// Temperatures as on_ams_load_curr works them out: an external spool uses its own range for
			// both; an AMS tray sends -1 for both unless a tray is loaded now and the target is known.
			const wanted = trayOf(ctx, o.tray);
			const loaded = trayOf(ctx, ctx.status?.activeTray ?? null);
			const [curr, tar] = external
				? [midTemp(wanted), midTemp(wanted)]
				: loaded && wanted
					? [midTemp(loaded), midTemp(wanted)]
					: [-1, -1];
			return {
				command: 'ams_change_filament',
				curr_temp: curr,
				tar_temp: tar,
				ams_id: amsId,
				target: index === 0 ? amsId : index,
				slot_id: external ? 0 : slot_id
			};
		},
		settled: (s, o) => s.activeTray === o.tray,
		timeoutMs: 15_000,
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.ams_change_filament:unload',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_ams_change_filament ~1639 with load = false ("target 255, slot_id 255: the new protocol to mark unload"), called as StatusPanel.cpp on_ams_unload ~5040 does with the default 210 °C temperatures',
		params: none,
		requires: ['amsSwitchCommand'],
		guard: (ctx) =>
			amsLoadReason(target(ctx)) ??
			(ctx.status && ctx.status.activeTray === null ? 'No filament is loaded.' : null),
		build: (_o, ctx) => {
			const loaded = ctx.status?.activeTray ?? null;
			return {
				command: 'ams_change_filament',
				curr_temp: 210,
				tar_temp: 210,
				ams_id: loaded === null ? EXT_MAIN : amsSlotOf(loaded).ams_id,
				target: 255,
				slot_id: 255
			};
		},
		settled: (s) => s.activeTray === null,
		timeoutMs: 15_000,
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.ams_control',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_ams_control ~1763; ha-bambulab commands.py RETRY_LOAD_FILAMENT_TEMPLATE / DONE_LOAD_FILAMENT_TEMPLATE',
		params: z.strictObject({ action: z.enum(['resume', 'done']) }),
		build: (o) => ({ command: 'ams_control', param: o.action }),
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.calibration',
		topic: 'print',
		source:
			'OpenBambuAPI mqtt.md "print.calibration"; option bits per Bambu Studio DeviceManager.cpp command_start_calibration ~1906',
		params: z.strictObject({
			lidar: z.boolean().optional(),
			bedLeveling: z.boolean().optional(),
			vibration: z.boolean().optional(),
			motorNoise: z.boolean().optional()
		}),
		guard: (ctx, o) => calibrationReason(target(ctx), o),
		build: (o) => ({
			command: 'calibration',
			option: (Object.keys(CALIBRATION_BITS) as (keyof CalibrationChoice)[]).reduce(
				(bits, k) => (o[k] ? bits | CALIBRATION_BITS[k] : bits),
				0
			)
		}),
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.skip_objects',
		topic: 'print',
		source:
			'OpenBambuAPI mqtt.md "print.skip_objects"; Bambu Studio DeviceManager.cpp command_task_partskip ~1408 (QoS 1)',
		params: z.strictObject({
			ids: z.array(z.number().int().min(0).max(0xffffff)).min(1).max(256)
		}),
		guard: (ctx) => skipReason(target(ctx)),
		build: (o) => ({ command: 'skip_objects', obj_list: o.ids }),
		settled: (s, o) => o.ids.every((id) => s.skippedObjects.includes(id)),
		qos: 1,
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.print_option',
		topic: 'print',
		source:
			'Bambu Studio DeviceCore/DevPrintOptions.cpp command_set_printing_option / command_set_prompt_sound / command_set_filament_tangle_detect / command_nozzle_blob_detect and DeviceManager.cpp command_ams_air_print_detect ~1872 / command_ams_switch_filament ~1858',
		params: z.strictObject({
			option: z.enum([
				'autoRecovery',
				'sound',
				'filamentTangle',
				'nozzleBlob',
				'airPrint',
				'autoSwitchFilament'
			]),
			enabled: z.boolean()
		}),
		guard: (ctx, o) =>
			o.option === 'autoSwitchFilament' && ctx.status && !ctx.status.ams.length
				? `The ${ctx.model.short} has no AMS.`
				: null,
		build: (o) => {
			const field: Record<PrintOptionName, Record<string, unknown>> = {
				autoRecovery: { option: o.enabled ? 1 : 0, auto_recovery: o.enabled },
				sound: { sound_enable: o.enabled },
				filamentTangle: { filament_tangle_detect: o.enabled },
				nozzleBlob: { nozzle_blob_detect: o.enabled },
				airPrint: { air_print_detect: o.enabled },
				autoSwitchFilament: { auto_switch_filament: o.enabled }
			};
			return { command: 'print_option', ...field[o.option] };
		},
		risk: 'safe'
	}),
	defineCommand({
		name: 'xcam.xcam_control_set',
		topic: 'xcam',
		source:
			'OpenBambuAPI mqtt.md "xcam.xcam_control_set" (module names); Bambu Studio DeviceCore/DevPrintOptions.cpp command_xcam_control ~456 (control, plus enable and print_halt for older firmware)',
		params: z.strictObject({
			detector: z.enum([
				'printing_monitor',
				'spaghetti_detector',
				'first_layer_inspector',
				'buildplate_marker_detector'
			]),
			enabled: z.boolean(),
			sensitivity: z.enum(['low', 'medium', 'high']).optional()
		}),
		guard: (ctx, o) => detectorReason(target(ctx), o.detector),
		build: (o) => ({
			command: 'xcam_control_set',
			module_name: o.detector,
			control: o.enabled,
			enable: o.enabled,
			print_halt: true,
			...(o.sensitivity && { halt_print_sensitivity: o.sensitivity })
		}),
		risk: 'safe'
	}),
	defineCommand({
		name: 'system.set_door_stat',
		topic: 'system',
		source:
			'Bambu Studio DeviceManager.cpp command_set_door_open_check ~4897 (config 0 nothing, 1 warn, 2 pause the print), offered when is_support_door_open_check (fun bit 12, ~4453) as PrintOptionsDialog.cpp does',
		params: z.strictObject({ mode: z.union([z.literal(0), z.literal(1), z.literal(2)]) }),
		guard: (ctx) =>
			ctx.status && ctx.status.firmwareSupport.doorOpenCheck !== true
				? `The ${ctx.model.short} does not report a door check.`
				: null,
		build: (o) => ({ command: 'set_door_stat', config: o.mode }),
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.gcode_line:custom',
		topic: 'print',
		source:
			'OpenBambuAPI mqtt.md "print.gcode_line"; ha-bambulab commands.py SEND_GCODE_TEMPLATE; blocklist in $lib/shared/controls GCODE_BLOCKED_WHILE_PRINTING',
		params: z.strictObject({
			lines: z
				.array(
					z
						.string()
						.max(GCODE_MAX_LINE)
						.regex(/^[\x20-\x7e]*$/, 'G-code lines must be plain printable text.')
				)
				.min(1)
				.max(GCODE_MAX_LINES)
		}),
		// M112 always, the blocklist while printing (line numbers, comments and leading zeros included).
		guard: (ctx, o) => gcodeReason(target(ctx), o.lines),
		build: (o) => gcode(`${o.lines.join('\n')}\n`),
		timeoutMs: 5000,
		risk: 'parent'
	})
];
