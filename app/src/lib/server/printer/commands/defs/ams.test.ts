import { describe, expect, it } from 'vitest';
import { commandDef, type CommandContext, type CommandName } from '../registry';
import { PRINTER_MODELS, capabilitiesFor, type ModelCode } from '$lib/shared/printers/models';
import {
	emptySnapshot,
	type AmsUnit,
	type PrinterSnapshot,
	type PrinterTray
} from '$lib/shared/printers/status';
import { parse } from '../../../validation';

const tray = (global: number, over: Partial<PrinterTray> = {}) =>
	({ global, type: 'PLA', color: '#ffffff', tagUid: null, ...over }) as PrinterTray;
const ctx = (model: ModelCode, status: Partial<PrinterSnapshot> = {}): CommandContext => ({
	printerId: 'p',
	model: PRINTER_MODELS[model],
	caps: capabilitiesFor(model, null),
	status: emptySnapshot({
		ams: [
			{ id: 0, model: 'AMS 2 Pro', trays: [0, 1, 2, 3].map((g) => tray(g)) } as AmsUnit,
			{ id: 128, model: 'AMS HT', trays: [tray(128)] } as AmsUnit,
			{ id: 1, model: 'AMS', trays: [tray(4, { tagUid: 'ABCD' })] } as AmsUnit
		],
		externalSpools: [tray(255), tray(254)],
		...status
	}),
	firmware: null
});
function payload(name: CommandName, params: unknown, model: ModelCode = 'N6') {
	const def = commandDef(name)!;
	const parsed = parse(def.params, params);
	return { [def.topic]: { sequence_id: 'SEQ', ...def.build(parsed as never, ctx(model)) } };
}
const guard = (name: CommandName, params: unknown, c = ctx('N6')) => {
	const def = commandDef(name)!;
	return def.guard?.(c, parse(def.params, params) as never) ?? null;
};

describe('AMS commands', () => {
	it('builds ams_filament_setting like Bambu Studio for AMS, AMS HT and external spools', () => {
		const base = { type: 'PETG', infoIdx: 'GFG99', color: 'ff0000ff', tempMin: 220, tempMax: 270 };
		expect(payload('print.ams_filament_setting', { ...base, tray: 6 })).toEqual({
			print: {
				sequence_id: 'SEQ',
				command: 'ams_filament_setting',
				ams_id: 1,
				slot_id: 2,
				tray_id: 2,
				tray_info_idx: 'GFG99',
				setting_id: '',
				tray_color: 'FF0000FF',
				nozzle_temp_min: 220,
				nozzle_temp_max: 270,
				tray_type: 'PETG'
			}
		});
		expect(payload('print.ams_filament_setting', { ...base, tray: 129 }).print).toMatchObject({
			ams_id: 129,
			slot_id: 0,
			tray_id: 0
		});
		// External spools: ams_id is the spool (255 main, 254 deputy), tray_id 254 (VIRTUAL_TRAY_DEPUTY_ID).
		expect(payload('print.ams_filament_setting', { ...base, tray: 255 }).print).toMatchObject({
			ams_id: 255,
			slot_id: 0,
			tray_id: 254
		});
		expect(
			payload('print.ams_filament_setting', {
				...base,
				tray: 0,
				colors: ['ff0000ff', '00ff00ff'],
				ctype: 1
			}).print
		).toMatchObject({ cols: ['FF0000FF', '00FF00FF'], ctype: 1 });
	});

	it('refuses to edit Bambu spools, missing trays, and while printing', () => {
		const p = { type: 'PLA', infoIdx: 'GFL99', color: 'FFFFFFFF', tempMin: 190, tempMax: 240 };
		expect(guard('print.ams_filament_setting', { ...p, tray: 0 })).toBeNull();
		expect(guard('print.ams_filament_setting', { ...p, tray: 4 })).toMatch(/RFID/);
		expect(guard('print.ams_filament_setting', { ...p, tray: 9 })).toMatch(/not on this printer/);
		expect(
			guard('print.ams_filament_setting', { ...p, tray: 0 }, ctx('N6', { gcodeState: 'RUNNING' }))
		).toMatch(/not printing/);
		expect(guard('print.ams_filament_setting', { ...p, tray: 0, tempMin: 250 })).toMatch(/above/);
		const def = commandDef('print.ams_filament_setting')!;
		expect(() => parse(def.params, { ...p, tray: 20 })).toThrow(/tray/);
		expect(() => parse(def.params, { ...p, tray: 0, color: '#fff' })).toThrow(/RRGGBBAA/);
	});

	it('re-reads a tag, sets the reading options for every unit', () => {
		expect(payload('print.ams_get_rfid', { tray: 7 })).toEqual({
			print: { sequence_id: 'SEQ', command: 'ams_get_rfid', ams_id: 1, slot_id: 3 }
		});
		expect(commandDef('print.ams_get_rfid')!.requires).toEqual(['amsReadRfid']);
		expect(guard('print.ams_get_rfid', { tray: 255 })).toMatch(/no RFID/);
		expect(
			payload('print.ams_user_setting', {
				startupRead: false,
				trayRead: true,
				remainCalibrate: true
			})
		).toEqual({
			print: {
				sequence_id: 'SEQ',
				command: 'ams_user_setting',
				ams_id: -1,
				startup_read_option: false,
				tray_read_option: true,
				calibrate_remain_flag: true
			}
		});
	});

	it('starts and stops drying with the fields Bambu Studio sends', () => {
		expect(
			payload('print.ams_filament_drying', { amsId: 0, temp: 55, hours: 8, filament: 'PLA' })
		).toEqual({
			print: {
				sequence_id: 'SEQ',
				command: 'ams_filament_drying',
				ams_id: 0,
				mode: 1,
				filament: 'PLA',
				temp: 55,
				duration: 8,
				humidity: 0,
				rotate_tray: false,
				cooling_temp: 50,
				close_power_conflict: false
			}
		});
		expect(payload('print.ams_filament_drying:stop', { amsId: 128 })).toEqual({
			print: {
				sequence_id: 'SEQ',
				command: 'ams_filament_drying',
				ams_id: 128,
				mode: 0,
				filament: '',
				temp: 0,
				duration: 0,
				humidity: 0,
				rotate_tray: false,
				cooling_temp: 0,
				close_power_conflict: false
			}
		});
		const p = { amsId: 0, temp: 70, hours: 8, filament: 'PLA' };
		expect(guard('print.ams_filament_drying', p)).toMatch(/65 °C/);
		expect(guard('print.ams_filament_drying', { ...p, amsId: 128 })).toBeNull();
		expect(guard('print.ams_filament_drying', { ...p, amsId: 1, temp: 50 })).toMatch(/cannot dry/);
		expect(guard('print.ams_filament_drying', { ...p, amsId: 2, temp: 50 })).toMatch(
			/not connected/
		);
		const def = commandDef('print.ams_filament_drying')!;
		expect(() => parse(def.params, { ...p, hours: 30 })).toThrow();
		expect(def.requires).toEqual(['amsDrying']);
	});
});
