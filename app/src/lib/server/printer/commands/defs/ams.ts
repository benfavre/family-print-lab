// AMS commands (ams package): tray filament settings, RFID re-read, the AMS reading options and
// drying. Payloads verified against Bambu Studio v02.08.02.61 src/slic3r/GUI/DeviceManager.cpp
// (command_ams_filament_settings ~1704, command_ams_refresh_rfid2 ~1745, command_ams_user_settings
// ~1677) and DeviceCore/DevFilaSystemCtrl.cpp (CtrlAmsStartDryingHour, CtrlAmsStopDrying), OpenBambuAPI
// mqtt.md (https://github.com/Doridian/OpenBambuAPI at cc383a2) and ha-bambulab pybambu/commands.py
// AMS_FILAMENT_DRYING_TEMPLATE (https://github.com/greghesp/ha-bambulab at 0e027ff).
import { z } from 'zod';
import { defineCommand } from '../registry';
import { amsSlotOf } from '../../report';
import { DRYING_HOURS, dryingRange } from '$lib/shared/ams';
import {
	ACTIVE_PRINTER_STATES,
	EXT_DEPUTY,
	EXT_MAIN,
	type AmsUnit,
	type GlobalTray,
	type PrinterSnapshot,
	type PrinterTray
} from '$lib/shared/printers/status';

export interface AmsFilamentSettingParams {
	tray: GlobalTray;
	/** tray_type, e.g. "PLA". */
	type: string;
	/** Bambu filament id (tray_info_idx), e.g. "GFL99"; "" leaves it unset. */
	infoIdx: string;
	/** Bambu preset id (setting_id); Bambu Studio sends "" when it has none. */
	settingId?: string;
	/** 'RRGGBBAA'. */
	color: string;
	tempMin: number;
	tempMax: number;
	/** Multi-colour spools: every colour ('RRGGBBAA') and the colour type (cols / ctype). */
	colors?: string[];
	ctype?: number;
}
export interface AmsDryingParams {
	/** The unit's id (0–3, 128–135). */
	amsId: number;
	temp: number;
	hours: number;
	/** tray_type of the filament being dried. */
	filament: string;
	rotateTray?: boolean;
	coolingTemp?: number;
}

declare module '../registry' {
	interface CommandMap {
		'print.ams_filament_setting': AmsFilamentSettingParams;
		'print.ams_get_rfid': { tray: GlobalTray };
		'print.ams_user_setting': {
			startupRead: boolean;
			trayRead: boolean;
			remainCalibrate: boolean;
		};
		'print.ams_filament_drying': AmsDryingParams;
		'print.ams_filament_drying:stop': { amsId: number };
	}
}

const isExternal = (t: GlobalTray) => t === EXT_MAIN || t === EXT_DEPUTY;
const tray = z
	.number()
	.int()
	.refine(
		(t) => (t >= 0 && t < 16) || (t >= 24 && t <= 27) || (t >= 128 && t <= 135) || isExternal(t),
		'Not a filament tray.'
	);
const rgba = z.string().regex(/^[0-9A-F]{8}$/i, 'Use an RRGGBBAA colour.');
const temp = z.number().int().min(0).max(400);
const amsId = z
	.number()
	.int()
	.refine((n) => (n >= 0 && n < 4) || (n >= 128 && n <= 135), 'Not an AMS unit.');

const printing = (s: PrinterSnapshot | null) => !!s && ACTIVE_PRINTER_STATES.has(s.gcodeState);
function findTray(s: PrinterSnapshot | null, global: GlobalTray): PrinterTray | undefined {
	return [...(s?.ams ?? []).flatMap((u) => u.trays), ...(s?.externalSpools ?? [])].find(
		(t) => t.global === global
	);
}
const findUnit = (s: PrinterSnapshot | null, id: number): AmsUnit | undefined =>
	s?.ams.find((u) => u.id === id);

export default [
	defineCommand({
		name: 'print.ams_filament_setting',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_ams_filament_settings ~1704 (ams_id, slot_id, tray_id = slot or 254 for external spools, tray_info_idx, setting_id, tray_color RRGGBBAA, nozzle_temp_min/max, tray_type, cols + ctype for multi-colour); OpenBambuAPI mqtt.md "print.ams_filament_setting"',
		params: z.strictObject({
			tray,
			type: z
				.string()
				.min(1)
				.max(20)
				.regex(/^[\w +-]+$/, 'Use a plain filament type such as PLA.'),
			infoIdx: z
				.string()
				.max(20)
				.regex(/^[\w-]*$/),
			settingId: z
				.string()
				.max(20)
				.regex(/^[\w-]*$/)
				.optional(),
			color: rgba,
			tempMin: temp,
			tempMax: temp,
			colors: z.array(rgba).max(16).optional(),
			ctype: z.number().int().min(0).max(10).optional()
		}),
		guard: (ctx, o) => {
			if (o.tempMin > o.tempMax) return 'The lowest nozzle temperature is above the highest.';
			const t = findTray(ctx.status, o.tray);
			if (ctx.status && !t) return 'That tray is not on this printer.';
			// Bambu spools are read-only: their details come from the tag (StatusPanel.cpp ~5168,
			// AMSMaterialsSetting.cpp ~547); editing while printing is refused (~551).
			if (t?.tagUid) return 'This is a Bambu spool: its details come from its RFID tag.';
			if (printing(ctx.status)) return 'Change tray settings when the printer is not printing.';
			return null;
		},
		build: (o) => {
			const { ams_id, slot_id } = amsSlotOf(o.tray);
			return {
				command: 'ams_filament_setting',
				ams_id,
				slot_id,
				tray_id: isExternal(o.tray) ? EXT_DEPUTY : slot_id,
				tray_info_idx: o.infoIdx,
				setting_id: o.settingId ?? '',
				tray_color: o.color.toUpperCase(),
				nozzle_temp_min: o.tempMin,
				nozzle_temp_max: o.tempMax,
				tray_type: o.type,
				...(o.colors?.length && {
					cols: o.colors.map((c) => c.toUpperCase()),
					ctype: o.ctype ?? 0
				})
			};
		},
		settled: (s, o) => {
			const t = findTray(s, o.tray);
			return (
				!!t &&
				t.type === o.type &&
				(t.color ?? '').replace('#', '').slice(0, 6).toUpperCase() === o.color.slice(0, 6)
			);
		},
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.ams_get_rfid',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_ams_refresh_rfid2 ~1745 ({ams_id, slot_id}); OpenBambuAPI mqtt.md "print.ams_get_rfid" (replies carry sequenceId)',
		params: z.strictObject({ tray }),
		requires: ['amsReadRfid'],
		guard: (ctx, o) => {
			if (isExternal(o.tray)) return 'External spools have no RFID reader.';
			if (ctx.status && !findTray(ctx.status, o.tray)) return 'That tray is not on this printer.';
			if (printing(ctx.status)) return 'Read the tag again once the print is finished.';
			return null;
		},
		build: (o) => ({ command: 'ams_get_rfid', ...amsSlotOf(o.tray) }),
		timeoutMs: 20_000,
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.ams_user_setting',
		topic: 'print',
		source:
			'Bambu Studio DeviceManager.cpp command_ams_user_settings ~1677 (ams_id -1 = every unit, startup_read_option, tray_read_option, calibrate_remain_flag); OpenBambuAPI mqtt.md "print.ams_user_setting"',
		params: z.strictObject({
			startupRead: z.boolean(),
			trayRead: z.boolean(),
			remainCalibrate: z.boolean()
		}),
		guard: (ctx) =>
			ctx.status && !ctx.status.ams.length ? 'This printer has no AMS connected.' : null,
		build: (o) => ({
			command: 'ams_user_setting',
			ams_id: -1,
			startup_read_option: o.startupRead,
			tray_read_option: o.trayRead,
			calibrate_remain_flag: o.remainCalibrate
		}),
		risk: 'safe'
	}),
	defineCommand({
		name: 'print.ams_filament_drying',
		topic: 'print',
		source:
			'Bambu Studio DevFilaSystemCtrl.cpp CtrlAmsStartDryingHour (mode 1 = OnTime, humidity 0, cooling_temp, close_power_conflict false) and AMSDryControl.cpp ~813 (cooling 50 °C unless the filament preset says) / ~1186 (45–65 °C AMS 2 Pro, 45–85 °C AMS HT) / ~1236 (1–24 h); ha-bambulab AMS_FILAMENT_DRYING_TEMPLATE and coordinator.py _service_call_filament_drying',
		params: z.strictObject({
			amsId,
			temp: z.number().int().min(45).max(85),
			hours: z.number().int().min(DRYING_HOURS.min).max(DRYING_HOURS.max),
			filament: z
				.string()
				.max(20)
				.regex(/^[\w +-]*$/),
			rotateTray: z.boolean().optional(),
			coolingTemp: z.number().int().min(45).max(100).optional()
		}),
		requires: ['amsDrying'],
		guard: (ctx, o) => {
			const unit = findUnit(ctx.status, o.amsId);
			if (ctx.status && !unit) return 'That AMS is not connected.';
			if (!unit) return null;
			const range = dryingRange(unit.model);
			if (!range) return `The ${unit.model} cannot dry filament; the AMS 2 Pro and AMS HT can.`;
			if (o.temp > range.max) return `The ${unit.model} dries at ${range.max} °C at most.`;
			return null;
		},
		build: (o) => ({
			command: 'ams_filament_drying',
			ams_id: o.amsId,
			mode: 1,
			filament: o.filament,
			temp: o.temp,
			duration: o.hours,
			humidity: 0,
			rotate_tray: o.rotateTray ?? false,
			cooling_temp: o.coolingTemp ?? 50,
			close_power_conflict: false
		}),
		settled: (s, o) => !!findUnit(s, o.amsId)?.drying,
		risk: 'confirm'
	}),
	defineCommand({
		name: 'print.ams_filament_drying:stop',
		topic: 'print',
		source:
			'Bambu Studio DevFilaSystemCtrl.cpp CtrlAmsStopDrying (ams_filament_drying with mode 0 = Off and zeroed fields), used by AMSDryControl.cpp ~527; ha-bambulab coordinator.py (mode 0)',
		params: z.strictObject({ amsId }),
		requires: ['amsDrying'],
		build: (o) => ({
			command: 'ams_filament_drying',
			ams_id: o.amsId,
			mode: 0,
			filament: '',
			temp: 0,
			duration: 0,
			humidity: 0,
			rotate_tray: false,
			cooling_temp: 0,
			close_power_conflict: false
		}),
		settled: (s, o) => !findUnit(s, o.amsId)?.drying,
		risk: 'safe'
	})
];
