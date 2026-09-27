// Printer controls shared by the server's command guards and the printer page: which control a printer
// has, when it may be used, and the plain-words reason when not. Both sides call the same functions, so
// a button is disabled for exactly the reason the server would refuse it.
// Sources: Bambu Studio v02.08.02.61 src/slic3r/GUI/StatusPanel.cpp, DeviceManager.cpp and DeviceCore/*
// (https://github.com/bambulab/BambuStudio), ha-bambulab pybambu (https://github.com/greghesp/ha-bambulab
// at 0e027ff), OpenBambuAPI mqtt.md (https://github.com/Doridian/OpenBambuAPI at cc383a2).
import type { Capabilities, PrinterModel } from './printers/models';
import type { PrinterSnapshot, SpeedLevel } from './printers/status';

/** What a guard needs to know about a printer (the command context, or the page's printer). */
export interface ControlTarget {
	model: PrinterModel;
	caps: Capabilities;
	status: PrinterSnapshot | null;
}

export type LightNode = 'chamber_light' | 'chamber_light2' | 'work_light' | 'heatbed_light';
export type FanName = 'part' | 'aux' | 'chamber' | 'secondaryAux';
export type Axis = 'X' | 'Y' | 'Z';
export type PrintOptionName =
	'autoRecovery' | 'sound' | 'filamentTangle' | 'nozzleBlob' | 'airPrint' | 'autoSwitchFilament';
export type Detector =
	| 'printing_monitor'
	| 'spaghetti_detector'
	| 'first_layer_inspector'
	| 'buildplate_marker_detector';
export type HaltSensitivity = 'low' | 'medium' | 'high';

export const SPEED_LEVELS: SpeedLevel[] = [1, 2, 3, 4];

/** Bambu Studio StatusPanel.cpp TEMP_THRESHOLD_ALLOW_E_CTRL: the extruder only moves above this. */
export const EXTRUDE_MIN_TEMP = 170;

/** Chamber temperatures above this switch the airduct to heating (Bambu Studio StatusPanel.cpp on_set_chamber_temp, DevConfig GetChamberTempSwitchHeat default). */
export const CHAMBER_HEAT_SWITCH = 40;

/** Airduct modes (Bambu Studio DeviceCore/DevFan.h AIR_DUCT). */
export const AIRDUCT_MODES: Record<number, string> = {
	0: 'Cooling',
	1: 'Heating',
	2: 'Exhaust',
	3: 'Full cooling'
};

export const LIGHT_LABELS: Record<LightNode, string> = {
	chamber_light: 'Chamber light',
	chamber_light2: 'Second chamber light',
	work_light: 'Work light',
	heatbed_light: 'Bed light'
};

export const FAN_LABELS: Record<FanName, string> = {
	part: 'Part cooling fan',
	aux: 'Auxiliary fan',
	chamber: 'Chamber fan',
	secondaryAux: 'Second auxiliary fan'
};

export const PRINT_OPTION_LABELS: Record<PrintOptionName, { label: string; help: string }> = {
	autoRecovery: {
		label: 'Recover from lost steps',
		help: 'The printer re-homes and carries on if a motor slips.'
	},
	sound: { label: 'Prompt sounds', help: 'Beeps when the printer needs someone.' },
	filamentTangle: {
		label: 'Filament tangle check',
		help: 'Pauses when the filament is tangled.'
	},
	nozzleBlob: { label: 'Nozzle blob check', help: 'Pauses when a blob builds up on the nozzle.' },
	airPrint: { label: 'Air printing check', help: 'Pauses when no filament comes out.' },
	autoSwitchFilament: {
		label: 'Switch to a matching spool',
		help: 'When a spool runs out, carry on with the same filament from another AMS slot.'
	}
};

export const DETECTOR_LABELS: Record<Detector, { label: string; help: string }> = {
	printing_monitor: {
		label: 'AI print check',
		help: 'The camera watches for spaghetti and other failures.'
	},
	spaghetti_detector: {
		label: 'Spaghetti check',
		help: 'The camera watches for a print that came loose.'
	},
	first_layer_inspector: {
		label: 'First layer check',
		help: 'The lidar checks the first layer before carrying on.'
	},
	buildplate_marker_detector: {
		label: 'Build plate check',
		help: 'Checks that the right plate is on the bed.'
	}
};

/** One option of print_option (Bambu Studio DevPrintOptions.cpp) as the printer reports it. */
export interface PrintOptionState {
	supported: boolean;
	enabled: boolean | null;
}
/** What the printer does when the door opens mid-print (Bambu Studio DeviceManager.hpp DoorOpenCheckState). */
export type DoorCheck = 0 | 1 | 2;
export const DOOR_CHECK_LABELS: Record<DoorCheck, string> = {
	0: 'Nothing',
	1: 'Warn',
	2: 'Pause the print'
};
export type PrintOptions = Record<PrintOptionName, PrintOptionState> & {
	/** Door-open check: supported from `fun` bit 12, mode from `cfg` bits 20–21. */
	doorCheck: { supported: boolean; mode: DoorCheck | null };
};

/** An object on the plate that skip_objects can drop (identify_id from the sliced file). */
export interface PlateObject {
	id: number;
	name: string;
	skipped: boolean;
	/** First-layer bounding box in bed millimetres: min x, min y, max x, max y (plate_<n>.json). */
	bbox: [number, number, number, number] | null;
}

export interface PlateObjects {
	/** 'file': read from the job's sliced file; 'report': the printer's skipped list only. */
	source: 'file' | 'report';
	plate: number | null;
	objects: PlateObject[];
	/** Every object's bounding box together (plate_<n>.json bbox_all), for the plate map. */
	bboxAll: [number, number, number, number] | null;
	/** Whether GET …/objects/plate.png has the plate picture. */
	picture: boolean;
	/** Whether GET …/objects/top.png and …/objects/pick.png make a clickable plate map. */
	pickMap: boolean;
	/** Ids the printer says are skipped (s_obj). */
	skipped: number[];
}

/**
 * The identify_id a pixel of Metadata/pick_<n>.png stands for, or null for the empty background. Bambu
 * Studio fills each object with r = id & 0xff, g = (id >> 8) & 0xff, b = (id >> 16) & 0xff, alpha 255,
 * on a clear (0, 0, 0, 0) background, without anti-aliasing (GLCanvas3D.cpp render_thumbnail
 * ~12512–12535 with vol->model_object_ID, set to the instance's identify_id in 3DScene.cpp ~1410).
 */
export function pickId(r: number, g: number, b: number, a: number): number | null {
	if (a < 255) return null;
	return r | (g << 8) | (b << 16);
}

// ---------- States ----------

const ACTIVE = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);
export const isActive = (s: PrinterSnapshot | null) => !!s && ACTIVE.has(s.gcodeState);
/** A-series bed slingers ("printer_arch": "i3" in Bambu Studio resources/printers/N1, N2S, N9.json). */
export const bedSlinger = (model: PrinterModel) => model.series === 'A1' || model.series === 'A2';
/** Dual-nozzle printers get Bambu Studio's per-extruder commands (StatusPanel.cpp nozzle_num == 2). */
export const dualNozzle = (t: ControlTarget) =>
	t.model.nozzles === 2 || (t.status?.nozzles.length ?? 0) > 1;
/** Bambu Studio's "new protocol" (is_enable_np; DeviceManager.cpp check_enable_np, report.ts). */
export const newProtocol = (s: PrinterSnapshot | null) => !!s?.newProtocol;
/** set_fan instead of M106: new protocol and an airduct (Bambu Studio Widgets/FanControl.cpp command_control_fan). */
export const newFanProtocol = (s: PrinterSnapshot | null) =>
	newProtocol(s) && s!.airductMode !== null;

const idleOnly = (s: PrinterSnapshot | null, what: string) =>
	isActive(s) ? `Wait until the print is over to ${what}.` : null;

// ---------- Per-control reasons (null = allowed) ----------

export function speedReason(t: ControlTarget): string | null {
	return isActive(t.status) ? null : 'Speed can only change while printing.';
}

export function lightReason(t: ControlTarget, node: LightNode): string | null {
	if (node === 'work_light' && !t.caps.workLight) return `The ${t.model.short} has no work light.`;
	if (node === 'chamber_light2' && !t.caps.chamberLight2)
		return `The ${t.model.short} has one chamber light.`;
	if (node === 'heatbed_light' && !t.caps.heatbedLight)
		return `The ${t.model.short} has no bed light.`;
	return null;
}

export type TempKind = 'nozzle' | 'bed' | 'chamber';

/** The highest temperature the model takes (Bambu Studio resources/printers: nozzle_temp_range, bed_temperature_limit, support_chamber_temp_edit_range). */
export function tempMax(t: ControlTarget, kind: TempKind): number | null {
	if (kind === 'nozzle') return t.model.nozzleTempMax;
	if (kind === 'bed') return t.model.bedTempMax;
	return t.caps.chamberTempEdit ? t.model.chamberTempMax : null;
}

export function tempReason(
	t: ControlTarget,
	kind: TempKind,
	temp: number,
	nozzle = 0
): string | null {
	if (kind === 'chamber') {
		if (!t.caps.chamberTempEdit) return `The ${t.model.short} cannot heat its chamber.`;
		// Bambu Studio StatusPanel.cpp on_set_chamber_temp: refused in cooling mode while printing.
		if (isActive(t.status) && t.caps.airductMode && t.status?.airductMode === 0)
			return 'The chamber temperature cannot change in cooling mode while printing.';
	}
	if (kind === 'nozzle' && nozzle === 1 && !dualNozzle(t))
		return `The ${t.model.short} has one nozzle.`;
	const max = tempMax(t, kind);
	if (max !== null && temp > max) return `The ${t.model.short} goes up to ${max} °C.`;
	if (temp < 0) return 'Temperatures start at 0 °C (off).';
	return null;
}

export function fanReason(t: ControlTarget, fan: FanName): string | null {
	if (fan === 'aux' && !t.caps.auxFan) return `The ${t.model.short} has no auxiliary fan.`;
	if (fan === 'chamber' && !t.caps.chamberFan) return `The ${t.model.short} has no chamber fan.`;
	if (fan === 'secondaryAux' && !t.caps.secondaryAuxFan)
		return `The ${t.model.short} has no second auxiliary fan.`;
	return null;
}

export function airductReason(t: ControlTarget): string | null {
	return t.caps.airductMode ? null : `The ${t.model.short} has no airduct modes.`;
}

export const homeReason = (t: ControlTarget) => idleOnly(t.status, 'home the printer');

/** Jog steps: Bambu Studio's MQTT jog knows 1 and 10 mm (DevAxisCtrl.cpp `mode`); G-code also takes 50 mm on X and Y. */
export function jogSteps(t: ControlTarget, axis: Axis): number[] {
	if (t.status?.firmwareSupport.mqttAxis || axis === 'Z') return [1, 10];
	return [1, 10, 50];
}

export function jogReason(t: ControlTarget, axis: Axis, distance: number): string | null {
	const busy = idleOnly(t.status, 'move the print head');
	if (busy) return busy;
	if (!jogSteps(t, axis).includes(Math.abs(distance)))
		return `The ${axis} axis moves in steps of ${jogSteps(t, axis).join(', ')} mm here.`;
	return null;
}

export function extrudeReason(t: ControlTarget, nozzle?: 0 | 1): string | null {
	const busy = idleOnly(t.status, 'move filament');
	if (busy) return busy;
	const s = t.status;
	const active = s?.activeNozzle ?? 0;
	if (nozzle === 1 && !dualNozzle(t)) return `The ${t.model.short} has one nozzle.`;
	// Bambu Studio StatusPanel.cpp on_axis_ctrl_e_*: only the extruder in use moves filament.
	if (nozzle !== undefined && nozzle !== active)
		return 'Only the nozzle in use can move filament; switch nozzles first.';
	// `nozzle` is the nozzle in use (report.ts).
	const now = s?.nozzle ?? s?.nozzles.find((x) => x.id === active)?.temp;
	return now != null && now >= EXTRUDE_MIN_TEMP
		? null
		: `Heat the nozzle above ${EXTRUDE_MIN_TEMP} °C first.`;
}

export function selectNozzleReason(t: ControlTarget): string | null {
	if (!t.caps.dualNozzle) return `The ${t.model.short} has one nozzle.`;
	return idleOnly(t.status, 'switch nozzles');
}

export function buzzerReason(t: ControlTarget): string | null {
	return t.caps.fireAlarmBuzzer ? null : `The ${t.model.short} has no alarm buzzer.`;
}

export interface CalibrationChoice {
	lidar?: boolean;
	bedLeveling?: boolean;
	vibration?: boolean;
	motorNoise?: boolean;
}

/** Which calibration steps a model offers (Bambu Studio DeviceManager.cpp command_start_calibration). */
export function calibrationSteps(t: ControlTarget): (keyof CalibrationChoice)[] {
	const steps: (keyof CalibrationChoice)[] = [];
	if (t.caps.lidar) steps.push('lidar');
	if (t.caps.bedLeveling) steps.push('bedLeveling');
	steps.push('vibration');
	if (t.caps.motorNoiseCali || t.status?.firmwareSupport.motorNoiseCali) steps.push('motorNoise');
	return steps;
}

export const CALIBRATION_LABELS: Record<keyof CalibrationChoice, string> = {
	lidar: 'Lidar',
	bedLeveling: 'Bed levelling',
	vibration: 'Vibration compensation',
	motorNoise: 'Motor noise cancellation'
};

export function calibrationReason(t: ControlTarget, o: CalibrationChoice): string | null {
	const busy = idleOnly(t.status, 'calibrate');
	if (busy) return busy;
	const offered = calibrationSteps(t);
	const chosen = (Object.keys(o) as (keyof CalibrationChoice)[]).filter((k) => o[k]);
	if (!chosen.length) return 'Choose at least one calibration step.';
	const missing = chosen.find((k) => !offered.includes(k));
	return missing
		? `The ${t.model.short} has no ${CALIBRATION_LABELS[missing].toLowerCase()}.`
		: null;
}

/** A check the model has, or one the printer reports a setting for (xcam in the report). */
export function detectorReason(t: ControlTarget, detector: Detector): string | null {
	const x = t.status?.xcam;
	const has =
		detector === 'printing_monitor'
			? t.caps.aiMonitoring || x?.printingMonitor != null
			: detector === 'spaghetti_detector'
				? t.caps.aiMonitoring || t.model.series === 'X1' || x?.spaghetti != null
				: detector === 'first_layer_inspector'
					? t.caps.firstLayerInspect || x?.firstLayer != null
					: t.caps.buildPlateMarkerDetect || x?.buildplateMarker != null;
	return has ? null : `The ${t.model.short} does not have this check.`;
}

export function amsLoadReason(t: ControlTarget): string | null {
	if (!t.caps.amsSwitchCommand)
		return `Loading filament from the app needs newer firmware on the ${t.model.short}.`;
	return idleOnly(t.status, 'change filament');
}

export function skipReason(t: ControlTarget): string | null {
	const state = t.status?.gcodeState;
	if (state !== 'RUNNING' && state !== 'PAUSE')
		return 'Objects can only be skipped while printing.';
	// Older firmware leaves the bit out; ha-bambulab allows skipping then too.
	if (t.status?.firmwareSupport.partSkip === false)
		return `This firmware on the ${t.model.short} cannot skip objects.`;
	return null;
}

// ---------- Custom G-code ----------

/**
 * Commands refused while a print runs, with the reason. They would home, level, cut power to the motors
 * or rewrite settings under a print that is still going (RepRap G-code reference; Bambu firmware
 * follows Marlin for these).
 */
export const GCODE_BLOCKED_WHILE_PRINTING: { code: string; reason: string }[] = [
	{ code: 'G28', reason: 'homing moves the head through the print' },
	{ code: 'G29', reason: 'bed levelling moves the head through the print' },
	{ code: 'G92', reason: 'resetting positions shifts the rest of the print' },
	{ code: 'M17', reason: 'motor power changes under a print' },
	{ code: 'M18', reason: 'switching motors off loses the position' },
	{ code: 'M84', reason: 'switching motors off loses the position' },
	{ code: 'M112', reason: 'an emergency stop needs the printer restarted' },
	{ code: 'M500', reason: 'saving settings mid-print can store half-changed values' },
	{ code: 'M501', reason: 'reloading settings changes them under the print' },
	{ code: 'M502', reason: 'factory reset changes settings under the print' },
	{ code: 'M999', reason: 'restarting the controller ends the print' }
];

/** G-code lines from a text box: trimmed, comments and blank lines dropped. */
export function gcodeLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.replace(/;.*$/, '').trim())
		.filter(Boolean);
}

/**
 * The command word of a G-code line, normalised ("n10 g028 x" → "G28"): comments, a leading line
 * number and leading zeros do not hide a command from the blocklist. Null for a line with no command.
 */
export function gcodeCommand(line: string): string | null {
	const m = line
		.replace(/;.*$/, '')
		.trim()
		.match(/^(?:N\d+\s*)?([GMT])0*(\d+)(?:\.(\d+))?/i);
	return m ? `${m[1].toUpperCase()}${m[2] || '0'}${m[3] ? `.${m[3]}` : ''}` : null;
}

export const GCODE_MAX_LINES = 50;
export const GCODE_MAX_LINE = 256;

/** Why these lines may not be sent now, or null. The server's guard and the G-code box both use it. */
export function gcodeReason(t: ControlTarget, lines: string[]): string | null {
	if (!lines.length) return 'Type at least one G-code line.';
	if (lines.length > GCODE_MAX_LINES) return `Send at most ${GCODE_MAX_LINES} lines at a time.`;
	if (lines.some((l) => l.length > GCODE_MAX_LINE))
		return `Lines can be up to ${GCODE_MAX_LINE} characters.`;
	if (lines.some((l) => !/^[\x20-\x7e]*$/.test(l)))
		return 'G-code lines must be plain printable text.';
	const codes = lines.map(gcodeCommand);
	if (codes.includes('M112'))
		return 'M112 is an emergency stop; it needs the printer restarted afterwards.';
	if (!isActive(t.status)) return null;
	for (const code of codes) {
		const blocked = GCODE_BLOCKED_WHILE_PRINTING.find((b) => b.code === code);
		if (blocked) return `${blocked.code} is blocked while printing: ${blocked.reason}.`;
	}
	return null;
}

// ---------- The whole printer ----------

/** Why no control can be used right now (offline, Developer Mode off), or null. */
export function offlineReason(p: {
	connected?: boolean;
	state?: PrinterSnapshot | null;
}): string | null {
	if (!p.connected) return 'The printer is not connected.';
	if (p.state?.developerMode === false) return 'Needs Developer Mode on the printer.';
	return null;
}
