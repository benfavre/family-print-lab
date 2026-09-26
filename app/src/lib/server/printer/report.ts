// Printer reports → typed status. Two pure functions hold all field knowledge:
// mergeReport() keeps the retained raw `print` state (X1 printers send everything, P1/A1 and newer send
// deltas), parseReport() builds the PrinterSnapshot the app uses. Everything comes off the network, so
// every value is optional, clamped and validated; unknown data is ignored rather than trusted.
// Field sources: ha-bambulab pybambu/models.py (https://github.com/greghesp/ha-bambulab at 0e027ff),
// Bambu Studio v02.08.02.61 src/slic3r/GUI/DeviceManager.cpp and DeviceCore/*, OpenBambuAPI mqtt.md.
import {
	EXT_DEPUTY,
	EXT_MAIN,
	type AmsUnit,
	type GlobalTray,
	type LightMode,
	type NozzleState,
	type PrinterSnapshot,
	type PrinterTray,
	type SpeedLevel,
	type VersionModule
} from '$lib/shared/printers/status';
import { capabilitiesFor, type PrinterModel } from '$lib/shared/printers/models';
import { stageName } from '$lib/shared/printers/stages';
import { HOME_FLAG, STAT_DOOR_OPEN_BIT, developerMode, firmwareSupport, hexFlag } from './flags';

export type Raw = Record<string, unknown>;

// ---------- Merge ----------

/**
 * Arrays whose elements carry an identity: a delta that mentions one element updates only that one
 * (ha-bambulab updates AMS units, trays, extruders and nozzles per id; Lights searches by node).
 * Every other array replaces the old one (hms, s_obj, stg, cols, mapping, airduct.modeList…).
 */
const KEYED: Record<string, string> = {
	'ams.ams': 'id',
	'ams.ams[].tray': 'id',
	'device.extruder.info': 'id',
	'device.nozzle.info': 'id',
	'device.airduct.parts': 'id',
	vir_slot: 'id',
	lights_report: 'node'
};
const MAX_ARRAY = 256;
const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const unsafeKey = (k: string) => k === '__proto__' || k === 'constructor' || k === 'prototype';
const clone = <T>(v: T): T => (v && typeof v === 'object' ? structuredClone(v) : v);

function mergeInto(target: Raw, patch: Raw, path: string) {
	for (const [key, value] of Object.entries(patch)) {
		// Reports come off the network: never let them reach object prototypes.
		if (unsafeKey(key)) continue;
		const here = path ? `${path}.${key}` : key;
		const current = target[key];
		const idKey = KEYED[here];
		if (idKey && Array.isArray(value)) {
			const list = Array.isArray(current) ? (current as unknown[]) : [];
			for (const item of value.slice(0, MAX_ARRAY)) {
				if (!isObject(item) || item[idKey] === undefined) continue;
				const id = String(item[idKey]);
				const existing = list.find((x) => isObject(x) && String(x[idKey]) === id) as
					Raw | undefined;
				if (existing) mergeInto(existing, item, `${here}[]`);
				else if (list.length < MAX_ARRAY) {
					const fresh: Raw = {};
					mergeInto(fresh, item, `${here}[]`);
					list.push(fresh);
				}
			}
			target[key] = list;
		} else if (isObject(value) && isObject(current)) mergeInto(current, value, here);
		else if (isObject(value)) {
			const fresh: Raw = {};
			mergeInto(fresh, value, here);
			target[key] = fresh;
		} else target[key] = Array.isArray(value) ? clone(value.slice(0, MAX_ARRAY)) : value;
	}
}

/**
 * Merges one `print` message into the retained raw state and returns it (mutated). Command replies
 * (`command` other than push_status) are not status: `ams_filament_setting` and friends echo their
 * parameters, which must not overwrite tray state.
 */
export function mergeReport(raw: Raw, patch: Raw): Raw {
	if (!isObject(patch)) return raw;
	const command = patch.command;
	if (typeof command === 'string' && command && command !== 'push_status') return raw;
	mergeInto(raw, patch, '');
	return raw;
}

// ---------- Values ----------

const num = (v: unknown): number | null => {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const positive = (v: unknown) => {
	const n = num(v);
	return n !== null && n > 0 ? n : null;
};
const text = (v: unknown, max = 200) =>
	typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '';
const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
/** 'RRGGBB' or 'RRGGBBAA' → '#rrggbb'. */
const color = (hex: unknown) =>
	typeof hex === 'string' && /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)
		? `#${hex.slice(0, 6).toLowerCase()}`
		: null;
const zeroToNull = (v: unknown, max = 64) => {
	const s = text(v, max);
	return s && !/^0+$/.test(s) ? s : null;
};
const obj = (v: unknown): Raw => (isObject(v) ? v : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(isObject) : []);
/** Packed temperatures on new firmware: low 16 bits current, high 16 bits target (ha-bambulab Temperature.print_update). */
const packed = (v: unknown) => {
	const n = num(v);
	return n === null ? null : { now: n & 0xffff, target: (n >> 16) & 0xffff };
};
/** Raw fan steps 0–15 → percent in 10 % steps (ha-bambulab utils.fan_percentage). */
const fanPercent = (v: unknown) => {
	const n = num(v);
	if (n === null) return null;
	return n ? Math.ceil(((n / 15) * 100) / 10) * 10 : 0;
};
const LIGHT_MODES = new Set(['on', 'off', 'flashing']);

// ---------- Trays ----------

/** Tray index from legacy `ams.tray_now` (Bambu Studio DevExtruderSystem.cpp ~276–305). */
export function trayFromTrayNow(value: unknown): GlobalTray | null {
	const n = num(value);
	if (n === null || n === 255) return null;
	if (n === EXT_DEPUTY) return EXT_MAIN; // 254 in tray_now = the (only) external spool
	if (n >= 0x80 && n <= 0x87) return n; // AMS HT: the unit id
	if (n >= 0 && n < 16) return n; // unit*4 + slot
	return null;
}

/** Tray index from `device.extruder.info[].snow` = (ams_id << 8) | slot_id (DevExtruderSystem.cpp ParseV2_0). */
export function trayFromSnow(value: unknown): GlobalTray | null {
	const n = num(value);
	if (n === null || n === 0xffff) return null;
	const ams = (n >> 8) & 0xff;
	const slot = n & 0xff;
	if (ams === EXT_MAIN || ams === EXT_DEPUTY) return slot === 0xff ? null : ams;
	if (ams >= 0x80 && ams <= 0x87) return ams;
	if (ams === 16) return slot < 4 ? 24 + slot : null; // A2L AMS Lite (DevDefs.h AMS_LITE_MIXED_TRAY_INDEX_OFFSET)
	if (ams < 4 && slot < 4) return ams * 4 + slot;
	return null;
}

/** Global tray → the `{ ams_id, slot_id }` pair project_file's ams_mapping2 wants (SelectMachine.cpp ~1424–1510). */
export function amsSlotOf(tray: GlobalTray): { ams_id: number; slot_id: number } {
	if (tray < 0) return { ams_id: 255, slot_id: 255 };
	if (tray === EXT_MAIN || tray === EXT_DEPUTY) return { ams_id: tray, slot_id: 0 };
	if (tray >= 0x80 && tray <= 0x87) return { ams_id: tray, slot_id: 0 };
	if (tray >= 24 && tray <= 27) return { ams_id: 16, slot_id: tray - 24 };
	if (tray >= 0 && tray < 16) return { ams_id: tray >> 2, slot_id: tray & 3 };
	return { ams_id: 255, slot_id: 255 };
}

/** ha-bambulab utils.ams_tray_spool_loaded over the tray `state` flags (SPOOL 0x01, STEADY 0x08). */
function spoolLoaded(state: number): boolean {
	if (!(state & 0x01)) return false;
	if (state <= 3) return state === 3;
	return (state & 0x08) !== 0;
}

function parseTray(t: Raw, global: GlobalTray, bblBits: unknown, active: Set<number>): PrinterTray {
	const state = num(t.state);
	const loaded = state === null ? true : spoolLoaded(state);
	const type = loaded ? text(t.tray_type, 40) : '';
	// External spools report remain 0 without measuring anything (ha-bambulab ExternalSpool.remain: -1).
	const external = global === EXT_MAIN || global === EXT_DEPUTY;
	const remain = external ? null : num(t.remain);
	return {
		slot: text(t.id, 8),
		active: active.has(global),
		type,
		name: type ? text(t.tray_sub_brands, 80) : '',
		color: type ? color(t.tray_color) : null,
		remain: type && remain !== null && remain >= 0 ? remain : null,
		global,
		colors: type
			? (Array.isArray(t.cols) ? t.cols : [])
					.slice(0, 16)
					.map(color)
					.filter((c): c is string => !!c)
			: [],
		infoIdx: type ? text(t.tray_info_idx, 20) : '',
		idName: type ? text(t.tray_id_name, 20) : '',
		tagUid: zeroToNull(t.tag_uid),
		trayUuid: zeroToNull(t.tray_uuid),
		weight: positive(t.tray_weight),
		diameter: positive(t.tray_diameter),
		tempMin: positive(t.nozzle_temp_min),
		tempMax: positive(t.nozzle_temp_max),
		bedTemp: positive(t.bed_temp),
		dryingTemp: positive(t.drying_temp),
		dryingHours: positive(t.drying_time),
		k: num(t.k),
		state,
		totalLengthMm: positive(t.total_len),
		// Same bit layout as tray_exist_bits (unit*4 + slot; DevFilaSystem.cpp ~777), AMS units 0–3 only.
		isBambu: global < 16 && hexFlag(bblBits, global) === 1
	};
}

const AMS_TYPES: Record<number, AmsUnit['model']> = {
	1: 'AMS',
	2: 'AMS Lite',
	3: 'AMS 2 Pro',
	4: 'AMS HT',
	5: 'AMS Lite'
};
/** get_version module prefixes (ha-bambulab AMSList.info_update). */
const MODULE_TYPES: [string, AmsUnit['model']][] = [
	['ams/', 'AMS'],
	['ams_f1/', 'AMS Lite'],
	['n3f/', 'AMS 2 Pro'],
	['n3s/', 'AMS HT']
];

function amsModule(versions: VersionModule[], id: number) {
	for (const [prefix, model] of MODULE_TYPES) {
		const m = versions.find((v) => v.name === `${prefix}${id}`);
		if (m) return { model, module: m };
	}
	return null;
}

function parseAms(
	ams: Raw,
	versions: VersionModule[],
	model: PrinterModel,
	remoteDrying: boolean,
	active: Set<number>
): AmsUnit[] {
	return list(ams.ams)
		.slice(0, 16)
		.map((u) => {
			const id = num(u.id) ?? 0;
			const info = u.info;
			const type = hexFlag(info, 0, 4);
			const found = amsModule(versions, id);
			const unitModel: AmsUnit['model'] =
				(type !== null ? AMS_TYPES[type] : undefined) ??
				found?.model ??
				(model.series === 'A1' ? 'AMS Lite' : 'Unknown');
			const extruder = hexFlag(info, 8, 4);
			const ht = unitModel === 'AMS HT' || (id >= 0x80 && id <= 0x87);
			const lite16 = type === 5 || id === 16;
			const humidityIndex = num(u.humidity);
			const humidityPercent = num(u.humidity_raw);
			const temp = num(u.temp);
			const dryTime = num(u.dry_time) ?? 0;
			const dry = obj(u.dry_setting);
			return {
				unit: text(u.id, 8),
				// AMS power-up can send bogus values; ha-bambulab ignores humidity outside 1–5 and temps outside 0–100.
				humidity:
					humidityIndex !== null && humidityIndex >= 1 && humidityIndex <= 5 ? humidityIndex : null,
				trays: list(u.tray)
					.slice(0, ht ? 1 : 4)
					.map((t) => {
						const slot = num(t.id) ?? 0;
						const global = ht ? id : lite16 ? 24 + slot : id * 4 + slot;
						return parseTray(t, global, ams.tray_is_bbl_bits, active);
					}),
				id,
				model: unitModel,
				humidityIndex:
					humidityIndex !== null && humidityIndex >= 1 && humidityIndex <= 5 ? humidityIndex : null,
				humidityPercent:
					humidityPercent !== null && humidityPercent >= 1 && humidityPercent <= 100
						? humidityPercent
						: null,
				temp: temp !== null && temp >= 0 && temp <= 100 ? temp : null,
				drying:
					dryTime > 0
						? {
								remainingMinutes: dryTime,
								temp: positive(dry.dry_temperature),
								durationHours: positive(dry.dry_duration),
								filament: text(dry.dry_filament, 40)
							}
						: null,
				serial: found?.module.serialTail || null,
				firmware: found?.module.sw || null,
				nozzle: extruder === null ? null : extruder === 0xe ? null : extruder,
				dryStatus: remoteDrying ? hexFlag(info, 4, 4) : null
			};
		});
}

// ---------- Version modules ----------

/** get_version `module[]` → modules, keeping only the last four characters of each serial. */
export function parseVersions(info: Raw): VersionModule[] {
	return list(info.module)
		.slice(0, 64)
		.map((m) => {
			const sn = text(m.sn, 64);
			return {
				name: text(m.name, 40),
				hw: text(m.hw_ver, 40),
				sw: text(m.sw_ver, 40),
				// Older firmware leaves product_name out and names the board in project_name (ha-bambulab get_printer_type).
				product: text(m.product_name, 80) || text(m.project_name, 40),
				serialTail: sn && !sn.includes('REDACTED') ? sn.slice(-4) : ''
			};
		});
}

export function firmwareVersion(versions: VersionModule[]): string | null {
	return versions.find((m) => m.name === 'ota')?.sw || null;
}

// ---------- Snapshot ----------

export interface ParseContext {
	model: PrinterModel;
	versions: VersionModule[];
	accessCodeSet: boolean;
}

/** Builds the typed snapshot from the merged raw `print` state. */
export function parseReport(raw: Raw, ctx: ParseContext): PrinterSnapshot {
	const p = raw;
	const { model, versions } = ctx;
	const firmware = firmwareVersion(versions);
	const caps = capabilitiesFor(model.code, firmware);
	const device = obj(p.device);
	const ams = obj(p.ams);
	const support = firmwareSupport(p.fun, p.fun2);

	// Extruders and what each one has loaded.
	const extruder = obj(device.extruder);
	const extruders = list(extruder.info).filter((e) => e.id === 0 || e.id === 1);
	const hasExtruders = Array.isArray(extruder.info);
	const extruderState = num(extruder.state);
	const activeNozzle = extruderState !== null ? (extruderState >> 4) & 0xf : 0;
	const nozzleInfo = list(obj(device.nozzle).info);
	const ids = hasExtruders
		? [...new Set(extruders.map((e) => e.id as number))].sort()
		: Array.from({ length: model.nozzles }, (_, i) => i);
	if (!ids.length) ids.push(0);
	const legacyTray = trayFromTrayNow(ams.tray_now);
	const nozzles: NozzleState[] = ids.map((id) => {
		const e = extruders.find((x) => x.id === id);
		const n = nozzleInfo.find((x) => x.id === id);
		const t = e ? packed(e.temp) : null;
		const classic = id === 0 && !t;
		return {
			id,
			temp: t ? t.now : classic ? round1(num(p.nozzle_temper)) : null,
			target: t ? t.target : classic ? round1(num(p.nozzle_target_temper)) : null,
			diameter: n ? positive(n.diameter) : id === 0 ? positive(p.nozzle_diameter) : null,
			type: (n ? text(n.type, 40) : id === 0 ? text(p.nozzle_type, 40) : '') || null,
			activeTray: hasExtruders ? (e ? trayFromSnow(e.snow) : null) : id === 0 ? legacyTray : null,
			wear: n ? num(n.wear) : null
		};
	});
	const active = nozzles.find((n) => n.id === activeNozzle) ?? nozzles[0];
	const loaded = new Set(nozzles.map((n) => n.activeTray).filter((t): t is number => t !== null));

	// Bed and chamber: packed values on new firmware, else the classic fields.
	const bed = packed(obj(obj(device.bed).info).temp);
	const chamber = packed(obj(obj(device.ctc).info).temp);

	// External spools: vir_slot[] ("255" main, "254" deputy) where sent, else vt_tray as the main one.
	const virSlots = Array.isArray(p.vir_slot) ? list(p.vir_slot) : null;
	const externalSpools = virSlots
		? virSlots
				.map((t) => ({ t, id: num(t.id) }))
				.filter((x) => x.id === EXT_MAIN || x.id === EXT_DEPUTY)
				.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
				.map(({ t, id }) => parseTray(t, id!, null, loaded))
		: isObject(p.vt_tray)
			? [parseTray(p.vt_tray, EXT_MAIN, null, loaded)]
			: [];

	// Lights by node.
	const lights = list(p.lights_report);
	const light = (node: string): LightMode | null => {
		const mode = lights.find((l) => l.node === node)?.mode;
		return typeof mode === 'string' && LIGHT_MODES.has(mode) ? (mode as LightMode) : null;
	};

	// Door: X1 series in home_flag, H2/P2/X2 in `stat` (ha-bambulab Info.print_update), where the model has one.
	const homeFlag = num(p.home_flag);
	let doorOpen: boolean | null = null;
	if (caps.doorSensor) {
		if (model.series === 'X1' && homeFlag !== null)
			doorOpen = (homeFlag & HOME_FLAG.DOOR_OPEN) !== 0;
		else if (p.stat !== undefined) {
			const bit = hexFlag(p.stat, STAT_DOOR_OPEN_BIT);
			doorOpen = bit === null ? null : bit === 1;
		}
	}

	// Camera: Bambu Studio DeviceManager.cpp ~3450–3466 (rtsp_url decides when present).
	const ipcam = obj(p.ipcam);
	const rtsp = typeof ipcam.rtsp_url === 'string' ? ipcam.rtsp_url : null;
	const localLive = text(obj(ipcam.liveview).local, 20);
	const lanLiveview: PrinterSnapshot['camera']['lanLiveview'] =
		rtsp !== null
			? rtsp === ''
				? null
				: rtsp === 'disable'
					? 'disabled'
					: rtsp.startsWith('rtsps')
						? 'rtsps'
						: 'rtsp'
			: localLive === 'disabled'
				? 'disabled'
				: localLive === 'local' || localLive === 'rtsps' || localLive === 'rtsp'
					? localLive
					: null;

	// Firmware update offer (read-only): new_ver_list on P1/A1, ota_new_version_number on X1 (ha-bambulab Upgrade).
	const upgrade = obj(p.upgrade_state);
	const ota = list(upgrade.new_ver_list).find((v) => v.name === 'ota');
	const newVersion = text(ota?.new_ver, 40) || text(upgrade.ota_new_version_number, 40) || null;

	// On boot the printer reports stg_cur 0 while idle (ha-bambulab StageAction.print_update).
	let stage = num(p.stg_cur);
	if (stage === 0 && text(p.print_type, 20) === 'idle') stage = 255;
	const speedLevel = num(p.spd_lvl);
	const sdPresent = homeFlag !== null ? homeFlag : null;

	return {
		gcodeState: text(p.gcode_state, 20) || 'UNKNOWN',
		percent: num(p.mc_percent),
		remainingMinutes: num(p.mc_remaining_time),
		layer: num(p.layer_num),
		totalLayers: num(p.total_layer_num),
		nozzle: active?.temp ?? null,
		nozzleTarget: active?.target ?? null,
		bed: bed ? bed.now : round1(num(p.bed_temper)),
		bedTarget: bed ? bed.target : round1(num(p.bed_target_temper)),
		chamber: chamber ? chamber.now : round1(num(p.chamber_temper)),
		task: text(p.subtask_name) || text(p.gcode_file),
		speedLevel,
		printError: num(p.print_error) || 0,
		hms: list(p.hms)
			.slice(0, 20)
			.map((h) => ({ attr: num(h.attr), code: num(h.code) })),
		wifiSignal: text(p.wifi_signal, 20),
		ams: parseAms(ams, versions, model, support.remoteDrying === true, loaded),
		chamberTarget: chamber ? chamber.target : null,
		stage: {
			id: stage,
			name: stageName(stage),
			subStage: num(p.mc_print_sub_stage),
			printStage: num(p.mc_print_stage)
		},
		speed: {
			level:
				speedLevel !== null && speedLevel >= 1 && speedLevel <= 4
					? (speedLevel as SpeedLevel)
					: null,
			magnitude: num(p.spd_mag)
		},
		fans: {
			part: fanPercent(p.cooling_fan_speed),
			aux: fanPercent(p.big_fan1_speed),
			chamber: fanPercent(p.big_fan2_speed),
			heatbreak: fanPercent(p.heatbreak_fan_speed),
			// device.airduct.parts[] id 160 is already a percentage (ha-bambulab Fans.print_update).
			secondaryAux: num(list(obj(device.airduct).parts).find((x) => x.id === 160)?.state)
		},
		airductMode: num(obj(device.airduct).modeCur),
		lights: {
			chamber: light('chamber_light'),
			chamber2: light('chamber_light2'),
			work: light('work_light'),
			heatbed: light('heatbed_light')
		},
		nozzles,
		activeNozzle,
		externalSpools,
		activeTray: active?.activeTray ?? null,
		xcam: {
			spaghetti: bool(obj(p.xcam).spaghetti_detector),
			firstLayer: bool(obj(p.xcam).first_layer_inspector),
			buildplateMarker: bool(obj(p.xcam).buildplate_marker_detector),
			printingMonitor: bool(obj(p.xcam).printing_monitor),
			printHalt: bool(obj(p.xcam).print_halt),
			haltSensitivity: text(obj(p.xcam).halt_print_sensitivity, 20) || null,
			allowSkipParts: bool(obj(p.xcam).allow_skip_parts)
		},
		sdCard:
			sdPresent !== null
				? sdPresent & HOME_FLAG.SD_CARD_ABNORMAL
					? 'abnormal'
					: sdPresent & HOME_FLAG.SD_CARD_PRESENT
						? 'normal'
						: 'missing'
				: typeof p.sdcard === 'boolean'
					? p.sdcard
						? 'normal'
						: 'missing'
					: null,
		doorOpen,
		camera: {
			present: typeof ipcam.ipcam_dev === 'string' ? ipcam.ipcam_dev === '1' : null,
			lanLiveview,
			rtspUrl: rtsp && /^rtsps?:\/\//.test(rtsp) ? rtsp.slice(0, 200) : null,
			recording: typeof ipcam.ipcam_record === 'string' ? ipcam.ipcam_record === 'enable' : null,
			timelapse: typeof ipcam.timelapse === 'string' ? ipcam.timelapse === 'enable' : null,
			resolution: text(ipcam.resolution, 20) || null
		},
		skippedObjects: (Array.isArray(p.s_obj) ? p.s_obj : [])
			.slice(0, 256)
			.map(num)
			.filter((n): n is number => n !== null),
		printType: text(p.print_type, 20) || null,
		gcodeFile: text(p.gcode_file),
		prepareProgress: num(p.gcode_file_prepare_percent),
		plate: { index: num(p.plate_idx ?? p.plate_id), count: num(p.plate_cnt) },
		developerMode: developerMode(p.fun),
		firmwareSupport: support,
		firmware: { version: firmware, modules: versions },
		upgrade: {
			available: num(upgrade.new_version_state) === 1,
			version: newVersion,
			state: text(upgrade.status, 40) || null
		},
		lastReportAt: null
	};
}
