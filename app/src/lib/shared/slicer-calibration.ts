// Calibration (the slicer-calibration package): the tests Print Lab Slicer prints (OrcaSlicer's
// Calibration menu generators, ported into the engine's features/calib: see
// slicer/engine/src/features/calib/calib.hpp), how to read each one, the filament setting each result
// goes into, and the printer's own flow dynamics (pressure advance) and flow rate calibration, whose
// K-value profiles Bambu Studio lists per filament and nozzle.
import type { Capabilities } from './printers/models';
import type { PrinterSnapshot } from './printers/status';
import type { ConfigMap, PresetRef } from './slicer/project';

export const CALIB_KINDS = [
	'flow_rate',
	'pa_line',
	'pa_pattern',
	'pa_tower',
	'temp_tower',
	'retraction',
	'max_volumetric',
	'vfa'
] as const;
export type CalibKind = (typeof CALIB_KINDS)[number];

/** What a test is asked for (calib.generate params.params); the engine checks the same rules. */
export interface CalibParams {
	start?: number;
	end?: number;
	step?: number;
	/** Flow rate: 1 coarse, 2 fine. */
	pass?: 1 | 2;
	/** Flow rate: OrcaSlicer's linear ("YOLO") test. */
	linear?: boolean;
	/** PA line: print the value beside each line. */
	printNumbers?: boolean;
}

/** One printed band or block and the value it was printed with. */
export interface CalibStep {
	value: number;
	label: string;
	/** Towers: where the band is (mm from the bed). */
	zMin?: number;
	zMax?: number;
}

export interface CalibTest {
	kind: CalibKind;
	title: string;
	/** One line for the test list. */
	blurb: string;
	/** Unit of the tested value. */
	unit: string;
	/** Start, end and step apply (flow rate has passes instead). */
	range: boolean;
	/** The filament preset key the winning value goes into (null: the result is advice only). */
	setting: { key: string; label: string } | null;
	/** How to read the print, step by step. */
	read: string[];
	/** How the result is picked: a band or block from the list, or a height measured on the tower. */
	pick: 'step' | 'height';
}

export const CALIB_TESTS: Record<CalibKind, CalibTest> = {
	flow_rate: {
		kind: 'flow_rate',
		title: 'Flow rate',
		blurb: 'Blocks printed with a little more or less plastic, to find the smoothest top.',
		unit: '',
		range: false,
		setting: { key: 'filament_flow_ratio', label: 'Flow ratio' },
		read: [
			'Let the print cool, then look at the tops under a bright light.',
			'Pick the block whose top is smoothest: no gaps between lines, and no ridges or rough patches from too much plastic.',
			'Run pass 2 after pass 1 for a finer result (pass 2 starts from the new value).'
		],
		pick: 'step'
	},
	pa_line: {
		kind: 'pa_line',
		title: 'Pressure advance: lines',
		blurb: 'Lines that change speed, one per pressure advance value. Quick to print.',
		unit: '',
		range: true,
		setting: { key: 'pressure_advance', label: 'Pressure advance' },
		read: [
			'Each line goes slow, fast, slow. The number beside it is its value.',
			'Pick the line that looks the same thickness all along: no blob where it slows down and no thin gap where it speeds up.'
		],
		pick: 'step'
	},
	pa_pattern: {
		kind: 'pa_pattern',
		title: 'Pressure advance: pattern',
		blurb: 'Nested corners, one per value. The easiest pressure advance test to read.',
		unit: '',
		range: true,
		setting: { key: 'pressure_advance', label: 'Pressure advance' },
		read: [
			'Look at the tips of the corners, where the nozzle turns.',
			'Too little: the tip bulges. Too much: the tip is thin or has a gap. Pick the sharpest, cleanest corner; the numbers are on every other one.'
		],
		pick: 'step'
	},
	pa_tower: {
		kind: 'pa_tower',
		title: 'Pressure advance: tower',
		blurb: 'A tower whose pressure advance rises a step every millimetre.',
		unit: '',
		range: true,
		setting: { key: 'pressure_advance', label: 'Pressure advance' },
		read: [
			'Look at the corners of the tower from the bottom up.',
			'Find the height where the corners are sharpest, with no bulge and no gap, and pick that band.'
		],
		pick: 'step'
	},
	temp_tower: {
		kind: 'temp_tower',
		title: 'Temperature tower',
		blurb: 'Blocks printed from hot to cool, 5 °C apart, to find the best nozzle temperature.',
		unit: '°C',
		range: true,
		setting: { key: 'nozzle_temperature', label: 'Nozzle temperature' },
		read: [
			'Each 10 mm block is 5 °C cooler than the one below. The temperature is printed on its side.',
			'Pick the block with the cleanest overhang and bridge, the least stringing, and walls that still bond well.'
		],
		pick: 'step'
	},
	retraction: {
		kind: 'retraction',
		title: 'Retraction',
		blurb: 'Two pillars with longer retraction every millimetre, to stop stringing.',
		unit: 'mm',
		range: true,
		setting: { key: 'filament_retraction_length', label: 'Retraction length' },
		read: [
			'The retraction length grows by one step every millimetre above the base.',
			'Find the lowest band where the strings between the pillars stop, and pick it.'
		],
		pick: 'step'
	},
	max_volumetric: {
		kind: 'max_volumetric',
		title: 'Max volumetric speed',
		blurb: 'A vase that prints faster as it grows, to find how much plastic the hotend can melt.',
		unit: 'mm³/s',
		range: true,
		setting: { key: 'filament_max_volumetric_speed', label: 'Max volumetric speed' },
		read: [
			'Look for the height where the wall first gets rough, thin or gappy.',
			'Measure that height from the bed with a ruler or callipers and enter it. The app works out the speed; staying a little under it gives some margin.'
		],
		pick: 'height'
	},
	vfa: {
		kind: 'vfa',
		title: 'Vertical fine artifacts (VFA)',
		blurb: 'A vase printed faster every 5 mm, to find speeds that leave fine vertical lines.',
		unit: 'mm/s',
		range: true,
		setting: null,
		read: [
			'Each 5 mm band is one step faster.',
			'Pick the fastest band whose walls are still smooth. Outer walls printed at or below that speed avoid the fine vertical lines.'
		],
		pick: 'step'
	}
};

/** Default nozzle temperatures by material (Bambu Studio calib_dlg.cpp on_filament_type_changed). */
const TEMP_RANGES: [RegExp, number, number][] = [
	[/^(ABS|ASA)/i, 270, 230],
	[/^PETG/i, 250, 230],
	[/^PCTG/i, 280, 240],
	[/^TPU/i, 240, 210],
	[/^PA.*CF|^PAHT/i, 320, 280],
	[/^PET.*CF/i, 320, 280]
];

/**
 * The starting values Bambu Studio's calibration dialogs offer (calib_dlg.cpp): PA per method and
 * extruder type, temperatures per material, speeds and lengths.
 */
export function calibDefaults(
	kind: CalibKind,
	o: { material?: string; bowden?: boolean } = {}
): CalibParams {
	switch (kind) {
		case 'flow_rate':
			return { pass: 1, linear: false };
		case 'pa_line':
			return o.bowden
				? { start: 0, end: 1, step: 0.02, printNumbers: true }
				: { start: 0, end: 0.1, step: 0.002, printNumbers: true };
		case 'pa_pattern':
			return o.bowden ? { start: 0, end: 1, step: 0.05 } : { start: 0, end: 0.08, step: 0.005 };
		case 'pa_tower':
			return o.bowden ? { start: 0, end: 1, step: 0.02 } : { start: 0, end: 0.1, step: 0.002 };
		case 'temp_tower': {
			const hit = TEMP_RANGES.find(([re]) => re.test(o.material ?? ''));
			return { start: hit?.[1] ?? 230, end: hit?.[2] ?? 190, step: 5 };
		}
		case 'retraction':
			return { start: 0, end: 2, step: 0.1 };
		case 'max_volumetric':
			return { start: 5, end: 20, step: 0.5 };
		case 'vfa':
			return { start: 40, end: 200, step: 10 };
	}
}

/** Plain words when the values cannot make a test (the engine's rules, checked before asking it). */
export function calibProblem(kind: CalibKind, p: CalibParams): string | null {
	if (kind === 'flow_rate')
		return p.pass === 1 || p.pass === 2 || p.pass === undefined
			? null
			: 'The flow rate test has a first and a second pass.';
	const { start, end, step } = p;
	if (![start, end, step].every((v) => typeof v === 'number' && Number.isFinite(v)))
		return 'Enter a start, an end and a step.';
	const s = start!,
		e = end!,
		st = step!;
	switch (kind) {
		case 'temp_tower':
			if (s > 350 || e < 180 || e > s - 5)
				return 'Pick a start of 350 °C or less, an end of 180 °C or more, and start at least 5 °C above the end.';
			return null;
		case 'pa_line':
		case 'pa_pattern':
		case 'pa_tower':
			if (!(st > 0)) return 'The step must be more than 0.';
			if (s < 0) return 'The start must be 0 or more.';
			if (e <= s) return 'The end must be more than the start.';
			if (kind === 'pa_line' && Math.ceil((e - s) / st - 1e-9) + 1 > 60)
				return 'That is more than 60 lines. Narrow the range or use a bigger step.';
			return null;
		case 'vfa':
			if (s <= 10) return 'The start speed must be more than 10 mm/s.';
			break;
		case 'max_volumetric':
			if (s <= 0) return 'The start must be more than 0.';
			break;
		case 'retraction':
			if (s < 0) return 'The start must be 0 or more.';
			break;
	}
	if (!(st > 0)) return 'The step must be more than 0.';
	if (e < s + st) return 'The end must be at least start + step.';
	return null;
}

/**
 * Max volumetric speed from the height where the vase first failed: GCode.cpp prints the outer wall at
 * start + z × step (in mm³/s once converted), so the speed at that height is start + z × step.
 */
export function volumetricAtHeight(p: CalibParams, heightMm: number): number {
	return Math.round(((p.start ?? 0) + heightMm * (p.step ?? 0)) * 10) / 10;
}

/** How many decimals a setting keeps (as Bambu Studio's presets write them). */
const DECIMALS: Record<string, number> = {
	filament_flow_ratio: 3,
	pressure_advance: 3,
	nozzle_temperature: 0,
	filament_retraction_length: 2,
	filament_max_volumetric_speed: 1
};

export function roundSetting(key: string, value: number): number {
	const d = DECIMALS[key] ?? 3;
	return Math.round(value * 10 ** d) / 10 ** d;
}

/**
 * The filament preset keys a result changes (single-filament presets store each value as a one-item
 * list). Pressure advance also turns enable_pressure_advance on, as it has no effect otherwise.
 */
export function calibChanges(kind: CalibKind, value: number): ConfigMap {
	const setting = CALIB_TESTS[kind].setting;
	if (!setting) return {};
	const text = String(roundSetting(setting.key, value));
	const out: ConfigMap = { [setting.key]: [text] };
	if (setting.key === 'pressure_advance') out.enable_pressure_advance = ['1'];
	return out;
}

export type CalibRunStatus = 'slicing' | 'ready' | 'failed' | 'done';

export interface CalibRun {
	id: string;
	kind: CalibKind;
	status: CalibRunStatus;
	title: string;
	printerId: string | null;
	spoolId: string | null;
	/** The filament preset the test was sliced with. */
	filament: PresetRef | null;
	params: CalibParams;
	steps: CalibStep[];
	/** Flow rate: the flow ratio the blocks' values start from. */
	baseFlowRatio: number | null;
	/** The print job holding the sliced test (on the Calibration project). */
	jobId: string | null;
	taskId: string | null;
	result: CalibResult | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CalibResult {
	value: number;
	/** The step picked, or "measured 12 mm". */
	label: string;
	/** The user preset the value went into, when it went into one. */
	preset: PresetRef | null;
	/** Whether the spool now slices with that preset. */
	spoolUpdated: boolean;
	at: string;
}

/** Why a test cannot be made right now (null: it can). */
export interface CalibAvailability {
	kind: CalibKind;
	available: boolean;
	reason: string | null;
}

export interface CalibOverview {
	engine: { name: string; version: string | null } | null;
	tests: CalibAvailability[];
	runs: CalibRun[];
	/** The family project calibration prints go into. */
	projectId: string | null;
	queue: boolean;
}

// ---------- The printer's own calibration (Bambu Studio device tab) ----------

/**
 * Why this printer cannot run its own flow dynamics (pressure advance) calibration or keep K-value
 * profiles: the `fun` bit it reports (flags.ts bit 7, Bambu Studio DeviceManager.cpp ~4440), else its
 * model's support_flow_calibration (Bambu Studio uses that field when the bit is absent, ~2890).
 */
export function paCalibrationReason(
	caps: Pick<Capabilities, 'flowCalibration'>,
	status: Pick<PrinterSnapshot, 'firmwareSupport'> | null
): string | null {
	const support = status?.firmwareSupport.paCalibration ?? caps.flowCalibration;
	return support ? null : 'This printer does not do flow dynamics calibration itself.';
}

/** The same for flow rate calibration (flags.ts bit 6, DeviceManager.cpp ~4438). */
export function flowCalibrationReason(
	caps: Pick<Capabilities, 'flowCalibration'>,
	status: Pick<PrinterSnapshot, 'firmwareSupport'> | null
): string | null {
	const support = status?.firmwareSupport.flowCalibration ?? caps.flowCalibration;
	return support ? null : 'This printer does not do flow rate calibration itself.';
}

/** The nozzle flow types Bambu Studio's nozzle ids encode (DeviceManager.cpp _generate_nozzle_id). */
export type NozzleVolume = 'standard' | 'high_flow' | 'tpu_high_flow' | 'e3d_high_flow';
const NOZZLE_LETTER: Record<NozzleVolume, string> = {
	standard: 'S',
	high_flow: 'H',
	tpu_high_flow: 'U',
	e3d_high_flow: 'B'
};

/** "0.4" for 0.4 mm; "0" for sizes Bambu's calibration does not know (to_string_nozzle_diameter). */
export function nozzleDiameterText(d: number): string {
	for (const n of [0.2, 0.4, 0.6, 0.8]) if (Math.abs(d - n) < 1e-3) return String(n);
	return '0';
}

/** "HS00-0.4": H, the flow type letter, 00, then the diameter (DeviceManager.cpp _generate_nozzle_id). */
export function nozzleId(volume: NozzleVolume, diameter: number): string {
	return `H${NOZZLE_LETTER[volume]}00-${nozzleDiameterText(diameter)}`;
}

/** The flow type from a nozzle id's second letter (DevCalib.cpp convert_to_nozzle_type). */
export function nozzleVolumeOf(id: string): NozzleVolume {
	const letter = id[1];
	return (
		(Object.entries(NOZZLE_LETTER).find(([, l]) => l === letter)?.[0] as NozzleVolume) ?? 'standard'
	);
}

/** One saved flow dynamics (K-value) profile on the printer. */
export interface KProfile {
	caliIdx: number;
	name: string;
	kValue: number;
	nCoef: number;
	filamentId: string;
	settingId: string;
	extruderId: number;
	nozzleId: string;
	nozzleDiameter: number;
	/** Results only: tray and confidence (0 good, 1 uncertain, 2 failed). */
	trayId?: number;
	confidence?: number;
}

export interface FlowRatioResult {
	trayId: number;
	nozzleDiameter: number;
	filamentId: string;
	settingId: string;
	flowRatio: number;
	confidence: number;
}

/** Numbers the firmware sends as numbers or as text (DevCalib.cpp get_number_flexible). */
function flexible(v: unknown, fallback = 0): number {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string') {
		const n = parseFloat(v);
		return Number.isFinite(n) ? n : fallback;
	}
	return fallback;
}
const int = (v: unknown, fallback: number) =>
	typeof v === 'number' && Number.isInteger(v) ? v : fallback;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The `filaments` of an extrusion_cali_get or extrusion_cali_get_result reply, read as Bambu Studio
 * reads them (DevCalib.cpp from_json(PACalibResult) and ExtrusionCalibGetTableParse): a missing nozzle
 * diameter comes from the reply itself, and K values outside 0–10 are dropped.
 */
export function parseKProfiles(reply: Record<string, unknown> | undefined): KProfile[] {
	const list = Array.isArray(reply?.filaments)
		? (reply.filaments as Record<string, unknown>[])
		: [];
	const fallbackDiameter = flexible(reply?.nozzle_diameter, 0.4);
	return list
		.filter((f) => f && typeof f === 'object')
		.map((f) => ({
			caliIdx: int(f.cali_idx, -1),
			name: str(f.name),
			kValue: flexible(f.k_value),
			nCoef: flexible(f.n_coef),
			filamentId: str(f.filament_id),
			settingId: str(f.setting_id),
			extruderId: int(f.extruder_id, 0),
			nozzleId: str(f.nozzle_id) || 'HS00-0.4',
			nozzleDiameter: flexible(f.nozzle_diameter, fallbackDiameter),
			...(f.tray_id !== undefined ? { trayId: int(f.tray_id, 0) } : {}),
			...(f.confidence !== undefined ? { confidence: int(f.confidence, 0) } : {})
		}))
		.filter((k) => k.kValue >= 0 && k.kValue <= 10);
}

/** A flowrate_get_result reply's `filaments` (DevCalib.cpp from_json(FlowRatioCalibResult)). */
export function parseFlowResults(reply: Record<string, unknown> | undefined): FlowRatioResult[] {
	const list = Array.isArray(reply?.filaments)
		? (reply.filaments as Record<string, unknown>[])
		: [];
	return list
		.filter((f) => f && typeof f === 'object')
		.map((f) => ({
			trayId: int(f.tray_id, 0),
			nozzleDiameter: flexible(f.nozzle_diameter),
			filamentId: str(f.filament_id),
			settingId: str(f.setting_id),
			flowRatio: flexible(f.flow_ratio),
			confidence: int(f.confidence, 0)
		}));
}

/** What the printer page's calibration panel shows. */
export interface PrinterCalibInfo {
	printerId: string;
	/** Why flow dynamics (PA) calibration and K profiles are off (null: available). */
	pa: string | null;
	/** Why flow rate calibration is off (null: available). */
	flow: string | null;
	nozzleDiameter: number;
	nozzleVolume: NozzleVolume;
	trays: {
		global: number;
		label: string;
		type: string;
		color: string | null;
		/** Bambu filament id (tray_info_idx); calibration needs one. */
		filamentId: string;
		/** Pressure advance the printer reports for this tray (A1/P1). */
		k: number | null;
	}[];
}
