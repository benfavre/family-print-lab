// What the app knows about a printer's live state, parsed from its MQTT reports (server/printer/report.ts).
// Units: °C, percent 0–100, minutes, millimetres. Every value is optional on the wire, so most are nullable.
import type { Capabilities, CameraProtocol, ModelCode } from './models';

export type LightMode = 'on' | 'off' | 'flashing';
/** silent, standard, sport, ludicrous (OpenBambuAPI mqtt.md print.print_speed). */
export type SpeedLevel = 1 | 2 | 3 | 4;
/**
 * One number per filament source, following Bambu Studio's tray index (DevFilaSystem.cpp
 * GetTrayIndexMap): 0–15 AMS / AMS 2 Pro / AMS Lite (unit*4+slot), 24–27 AMS Lite on the A2L (AMS
 * type 5, unit id 16), 128–135 AMS HT (the unit id, one slot), 255 = main (right, or only) external
 * spool, 254 = deputy (left) external spool. "Nothing loaded" is `null`, never 255.
 */
export type GlobalTray = number;
/** Bambu Studio DeviceCore/DevDefs.h VIRTUAL_TRAY_MAIN_ID. */
export const EXT_MAIN = 255;
/** Bambu Studio DeviceCore/DevDefs.h VIRTUAL_TRAY_DEPUTY_ID. */
export const EXT_DEPUTY = 254;

/** An HMS alert as reported (the hms package decodes it). */
export interface HmsCode {
	attr: number | null;
	code: number | null;
}

export interface PrinterTray {
	slot: string;
	active: boolean;
	type: string;
	name: string;
	color: string | null;
	remain: number | null;
	/** Global tray number (see GlobalTray). */
	global: GlobalTray;
	/** `cols` (multi-colour spools), '#rrggbb'. */
	colors: string[];
	/** tray_info_idx, e.g. "GFA00" (Bambu filament id). */
	infoIdx: string;
	/** tray_id_name, e.g. "A00-W1". */
	idName: string;
	/** tag_uid; null when all zeros. */
	tagUid: string | null;
	/** tray_uuid; null when all zeros. */
	trayUuid: string | null;
	/** tray_weight (g, spool nominal). */
	weight: number | null;
	diameter: number | null;
	tempMin: number | null;
	tempMax: number | null;
	bedTemp: number | null;
	dryingTemp: number | null;
	dryingHours: number | null;
	/** Pressure advance when reported (A1/P1). */
	k: number | null;
	/** Tray `state` flags when present. */
	state: number | null;
	/** total_len (mm). */
	totalLengthMm: number | null;
	/** From ams.tray_is_bbl_bits. */
	isBambu: boolean;
}

export interface AmsUnit {
	unit: string;
	humidity: number | null;
	trays: PrinterTray[];
	/** Numeric id: 0–3; 16 for the A2L's AMS Lite; 128–135 for AMS HT. */
	id: number;
	/**
	 * From the unit's `info` hex bits 0–3: 1 AMS, 2 AMS Lite, 3 AMS 2 Pro (N3F), 4 AMS HT (N3S), 5 AMS
	 * Lite on the A2L (Bambu Studio DevDefs.h DevAmsType, DevFilaSystem.cpp ~597); without `info`, the
	 * get_version module names ams/, ams_f1/, n3f/, n3s/ (ha-bambulab AMSList.info_update), and AMS
	 * Lite on the A1 / A1 mini.
	 */
	model: 'AMS' | 'AMS Lite' | 'AMS 2 Pro' | 'AMS HT' | 'Unknown';
	/** `humidity` level 1–5 as reported (ha-bambulab ignores other values). */
	humidityIndex: number | null;
	/** `humidity_raw` 1–100. */
	humidityPercent: number | null;
	temp: number | null;
	/** dry_time, dry_setting.*; null when not drying. */
	drying: {
		remainingMinutes: number;
		temp: number | null;
		durationHours: number | null;
		filament: string;
	} | null;
	serial: string | null;
	firmware: string | null;
	/** Extruder it feeds: `info` bits 8–11 (0 main/right, 1 deputy/left; 0xE through the filament switcher → null). */
	nozzle: number | null;
	/** `info` bits 4–7 when the printer supports remote drying (fun2 bit 5); raw. */
	dryStatus: number | null;
}

export interface NozzleState {
	/** 0 = right / single, 1 = left. */
	id: number;
	temp: number | null;
	target: number | null;
	diameter: number | null;
	/** 'hardened_steel' | 'stainless_steel' | new codes like 'HS01' (raw). */
	type: string | null;
	/** From device.extruder.info[].snow (Bambu Studio DevExtruderSystem.cpp ParseV2_0), else legacy tray_now. */
	activeTray: GlobalTray | null;
	wear: number | null;
}

export interface VersionModule {
	name: string;
	hw: string;
	sw: string;
	product: string;
	/** Last four characters of the module serial (the rest is never kept). */
	serialTail: string;
}

export interface PrinterSnapshot {
	// ---- existing (unchanged meaning) ----
	gcodeState: string;
	percent: number | null;
	remainingMinutes: number | null;
	layer: number | null;
	totalLayers: number | null;
	/** The active nozzle. */
	nozzle: number | null;
	nozzleTarget: number | null;
	bed: number | null;
	bedTarget: number | null;
	chamber: number | null;
	task: string;
	speedLevel: number | null;
	printError: number;
	hms: HmsCode[];
	wifiSignal: string;
	ams: AmsUnit[];
	// ---- new ----
	/** device.ctc.info.temp high word. */
	chamberTarget: number | null;
	/** stg_cur (255 / -1 idle), mc_print_sub_stage, mc_print_stage. */
	stage: { id: number | null; name: string; subStage: number | null; printStage: number | null };
	/** spd_lvl, spd_mag (%). */
	speed: { level: SpeedLevel | null; magnitude: number | null };
	/** Percent; raw 0–15 → ceil(raw/15*100/10)*10 (ha-bambulab utils.fan_percentage); airduct part 160 is already %. */
	fans: {
		part: number | null;
		aux: number | null;
		chamber: number | null;
		heatbreak: number | null;
		secondaryAux: number | null;
	};
	/** device.airduct.modeCur. */
	airductMode: number | null;
	lights: {
		chamber: LightMode | null;
		chamber2: LightMode | null;
		work: LightMode | null;
		heatbed: LightMode | null;
	};
	/** Length 1 or 2. */
	nozzles: NozzleState[];
	/** (device.extruder.state >> 4) & 0xF, else 0. */
	activeNozzle: number;
	/** vt_tray, or vir_slot[] on printers that send it. */
	externalSpools: PrinterTray[];
	/** The active nozzle's tray; null when nothing is loaded. */
	activeTray: GlobalTray | null;
	xcam: {
		spaghetti: boolean | null;
		firstLayer: boolean | null;
		buildplateMarker: boolean | null;
		printingMonitor: boolean | null;
		printHalt: boolean | null;
		haltSensitivity: string | null;
		allowSkipParts: boolean | null;
	};
	/** home_flag bits 0x100 present / 0x200 abnormal, else the `sdcard` boolean. */
	sdCard: 'normal' | 'missing' | 'abnormal' | null;
	/** home_flag (X1) or stat bit 0x00800000 where supported. */
	doorOpen: boolean | null;
	camera: {
		/** ipcam.ipcam_dev === "1". */
		present: boolean | null;
		/** From ipcam.rtsp_url / ipcam.liveview.local (Bambu Studio DeviceManager.cpp ~3450). */
		lanLiveview: 'rtsps' | 'rtsp' | 'local' | 'disabled' | null;
		/** Host part redacted in client payloads; the camera module uses the registry host. */
		rtspUrl: string | null;
		recording: boolean | null;
		timelapse: boolean | null;
		resolution: string | null;
	};
	/** s_obj. */
	skippedObjects: number[];
	printType: string | null;
	gcodeFile: string;
	/** gcode_file_prepare_percent. */
	prepareProgress: number | null;
	/** plate_idx / plate_cnt where reported. */
	plate: { index: number | null; count: number | null };
	/** Bit 29 of `fun` clear (ha-bambulab Print_Fun_Values.MQTT_SIGNATURE_REQUIRED); null without `fun`. */
	developerMode: boolean | null;
	/**
	 * Feature bits the printer itself reports, decoded with flags.ts (Bambu Studio DeviceManager.cpp
	 * ~4430–4480, DevAxis.cpp ~15): undefined when the source string is absent.
	 */
	firmwareSupport: {
		mqttBedTemp?: boolean;
		mqttHoming?: boolean;
		mqttAxis?: boolean;
		partSkip?: boolean;
		flowCalibration?: boolean;
		paCalibration?: boolean;
		motorNoiseCali?: boolean;
		internalTimelapse?: boolean;
		doorOpenCheck?: boolean;
		nozzleRack?: boolean;
		remoteDrying?: boolean;
		printWithEmmc?: boolean;
	};
	/** get_version (ota sw_ver). */
	firmware: { version: string | null; modules: VersionModule[] };
	/** upgrade_state / new_ver_list (read-only). */
	upgrade: { available: boolean; version: string | null; state: string | null };
	lastReportAt: string | null;
}

export interface PrinterStatus {
	configured: boolean;
	name?: string;
	simulated?: boolean;
	connected?: boolean;
	lastSeen?: string | null;
	error?: string;
	warning?: string;
	printing?: boolean;
	state?: PrinterSnapshot | null;
	// Always set when configured:
	id?: string;
	model?: ModelCode;
	modelName?: string;
	/** capabilitiesFor(model, firmware). */
	caps?: Capabilities;
	camera?: CameraProtocol;
	enabled?: boolean;
}

export const ACTIVE_PRINTER_STATES = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);

/** A snapshot with nothing reported yet (tests, and printers that have not sent a report). */
export function emptySnapshot(over: Partial<PrinterSnapshot> = {}): PrinterSnapshot {
	return {
		gcodeState: 'UNKNOWN',
		percent: null,
		remainingMinutes: null,
		layer: null,
		totalLayers: null,
		nozzle: null,
		nozzleTarget: null,
		bed: null,
		bedTarget: null,
		chamber: null,
		task: '',
		speedLevel: null,
		printError: 0,
		hms: [],
		wifiSignal: '',
		ams: [],
		chamberTarget: null,
		stage: { id: null, name: '', subStage: null, printStage: null },
		speed: { level: null, magnitude: null },
		fans: { part: null, aux: null, chamber: null, heatbreak: null, secondaryAux: null },
		airductMode: null,
		lights: { chamber: null, chamber2: null, work: null, heatbed: null },
		nozzles: [],
		activeNozzle: 0,
		externalSpools: [],
		activeTray: null,
		xcam: {
			spaghetti: null,
			firstLayer: null,
			buildplateMarker: null,
			printingMonitor: null,
			printHalt: null,
			haltSensitivity: null,
			allowSkipParts: null
		},
		sdCard: null,
		doorOpen: null,
		camera: {
			present: null,
			lanLiveview: null,
			rtspUrl: null,
			recording: null,
			timelapse: null,
			resolution: null
		},
		skippedObjects: [],
		printType: null,
		gcodeFile: '',
		prepareProgress: null,
		plate: { index: null, count: null },
		developerMode: null,
		firmwareSupport: {},
		firmware: { version: null, modules: [] },
		upgrade: { available: false, version: null, state: null },
		lastReportAt: null,
		...over
	};
}
