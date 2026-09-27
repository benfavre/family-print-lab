// The simulator's AMS feature on its own (no network): drying states, controls, tags.
import { describe, expect, it } from 'vitest';
import { createSimulator } from '../core';
import { ams } from './ams';
import { hexFlag } from '../../flags';

const sim = (model: 'N6' | 'C12' | 'N1') => createSimulator({ model, log: () => {} }).sim;
const run = (s: ReturnType<typeof sim>, msg: Record<string, unknown>) =>
	ams.command!(s, 'print', msg);

describe('simulated AMS', () => {
	it('tags Bambu spools in AMS trays only', () => {
		const p1s = sim('C12');
		const trays = p1s.trays();
		expect(trays.find((t) => t.global === 0)!.tray.tray_uuid).toMatch(/^[0-9A-F]{32}$/);
		expect(trays.find((t) => t.global === 255)!.tray.tray_uuid).toMatch(/^0+$/);
		// Stable across restarts, so links survive.
		expect(sim('C12').trays()[0].tray.tray_uuid).toBe(trays[0].tray.tray_uuid);
	});

	it('dries through checking, drying, cooling and off', () => {
		const x2d = sim('N6');
		const unit = x2d.state.ams.ams[0];
		expect(
			run(x2d, {
				command: 'ams_filament_drying',
				ams_id: 0,
				mode: 1,
				temp: 60,
				duration: 1,
				filament: 'PLA'
			})
		).toEqual({ result: 'success' });
		expect(hexFlag(unit.info, 4, 4)).toBe(1);
		ams.step!(x2d, 6);
		expect(hexFlag(unit.info, 4, 4)).toBe(2);
		for (let i = 0; i < 60 * 60; i += 30) ams.step!(x2d, 30);
		expect(unit.dry_time).toBe(0);
		expect(hexFlag(unit.info, 4, 4)).toBe(3);
		ams.step!(x2d, 121);
		expect(hexFlag(unit.info, 4, 4)).toBe(0);
		expect(unit.dry_setting.dry_temperature).toBe(-1);
		// A plain AMS cannot dry.
		const p1s = sim('C12');
		expect(
			run(p1s, { command: 'ams_filament_drying', ams_id: 0, mode: 1, temp: 55, duration: 2 })
		).toMatchObject({ result: 'failed' });
	});

	it('connects an AMS HT and another AMS, and loads a Bambu spool', () => {
		const x2d = sim('N6');
		const control = (id: string) => ams.controls!.find((c) => c.id === id)!.run(x2d, {});
		control('ams-add-ht');
		control('ams-add-unit');
		const units = x2d.state.ams.ams.map((u: { id: string }) => u.id);
		expect(units).toEqual(['0', '128', '1']);
		expect(hexFlag(x2d.state.ams.ams_exist_bits, 4)).toBe(1);
		expect(hexFlag(x2d.state.ams.ams_exist_bits, 1)).toBe(1);
		const ht = x2d.trays().find((t) => t.global === 128)!;
		expect(ht.tray).toMatchObject({ tray_type: 'PETG', tray_sub_brands: 'PETG HF' });
		control('ams-load-bambu');
		expect(x2d.trays().filter((t) => t.tray.tray_info_idx === 'GFA00').length).toBeGreaterThan(0);
	});

	it('sets a tray and the reading options', () => {
		const a1 = sim('N1');
		expect(
			run(a1, {
				command: 'ams_filament_setting',
				ams_id: 0,
				slot_id: 1,
				tray_id: 1,
				tray_info_idx: 'GFG99',
				tray_type: 'PETG',
				tray_color: '00ff00ff',
				nozzle_temp_min: 220,
				nozzle_temp_max: 270
			})
		).toEqual({ result: 'success' });
		expect(a1.state.ams.ams[0].tray[1]).toMatchObject({
			tray_type: 'PETG',
			tray_color: '00FF00FF',
			nozzle_temp_max: '270'
		});
		run(a1, {
			command: 'ams_user_setting',
			ams_id: -1,
			startup_read_option: false,
			tray_read_option: true,
			calibrate_remain_flag: false
		});
		expect(a1.state.ams).toMatchObject({
			power_on_flag: false,
			insert_flag: true,
			calibrate_remain_flag: false
		});
		expect(run(a1, { command: 'ams_get_rfid', ams_id: 3, slot_id: 0 })).toMatchObject({
			result: 'failed'
		});
	});
});
