// AMS behaviour for the simulator (ams package): Bambu spools carry RFID tags, tray settings and RFID
// re-reads change the tray, the reading options are remembered, humidity drifts, and AMS 2 Pro / AMS HT
// units dry filament through the same states the firmware reports (AMS `info` bits 4–7: 1 checking,
// 2 drying, 3 cooling, 4 stopping, 0 off; Bambu Studio DevFilaSystem.h DryStatus, DevFilaSystem.cpp
// ~596). Control-page buttons load a Bambu spool and connect another AMS or an AMS HT.
import { createHash } from 'node:crypto';
import { hexFlag } from '../../flags';
import type { Json, SimFeature, SimPrinter } from '../core';

interface DryState {
	/** Seconds into the current drying minute / state. */
	seconds: number;
	/** Seconds left in a transient state (checking, cooling, stopping). */
	hold: number;
}
interface AmsSim {
	dry: Map<string, DryState>;
	reading: { global: number; left: number }[];
	humidityClock: number;
}
const states = new WeakMap<SimPrinter, AmsSim>();
const stateOf = (sim: SimPrinter): AmsSim => {
	let s = states.get(sim);
	if (!s) states.set(sim, (s = { dry: new Map(), reading: [], humidityClock: 0 }));
	return s;
};

const ZERO_UUID = '00000000000000000000000000000000';
const isZero = (v: unknown) => !v || /^0+$/.test(String(v));
/** Bambu's own filament ids start with GF (e.g. GFA00 PLA Basic). */
const bambuIdx = (v: unknown) => /^GF[A-Z]\d/.test(String(v ?? ''));
const hash = (text: string) => createHash('sha256').update(text).digest('hex').toUpperCase();

/** A stable RFID identity for a simulated Bambu spool. */
function tagTray(sim: SimPrinter, tray: Json, where: string) {
	const h = hash(`${sim.serial}:${where}:${tray.tray_info_idx}:${tray.tray_color}`);
	tray.tray_uuid = h.slice(0, 32);
	tray.tag_uid = `${h.slice(32, 44)}0100`;
	if (isZero(tray.tray_weight)) tray.tray_weight = '1000';
	if (!tray.tray_sub_brands) tray.tray_sub_brands = `${tray.tray_type} Basic`;
}

/** Sets bits `bit`…`bit+3` of a hex flag string, keeping its length. */
function setNibble(hex: unknown, bit: number, value: number): string {
	const text = typeof hex === 'string' && /^[0-9a-f]+$/i.test(hex) ? hex : '0';
	let v = BigInt(`0x${text}`);
	v = (v & ~(0xfn << BigInt(bit))) | (BigInt(value & 0xf) << BigInt(bit));
	return v.toString(16).toUpperCase().padStart(text.length, '0');
}
const setBit = (hex: unknown, bit: number, on: boolean) => {
	const text = typeof hex === 'string' && /^[0-9a-f]+$/i.test(hex) ? hex : '0';
	const v = on
		? BigInt(`0x${text}`) | (1n << BigInt(bit))
		: BigInt(`0x${text}`) & ~(1n << BigInt(bit));
	return v.toString(16);
};

/** The tray an ams_id / slot_id pair names (254/255: the external spools). */
function trayAt(sim: SimPrinter, amsId: number, slotId: number): Json | undefined {
	if (amsId === 254 || amsId === 255) {
		const found = sim.trays().find((t) => !t.unit && t.global === amsId);
		return (found ?? sim.trays().find((t) => !t.unit))?.tray;
	}
	const unit = (sim.state.ams?.ams ?? []).find((u: Json) => Number(u.id) === amsId);
	return (unit?.tray ?? []).find((t: Json) => Number(t.id) === slotId);
}
const unitById = (sim: SimPrinter, id: number): Json | undefined =>
	(sim.state.ams?.ams ?? []).find((u: Json) => Number(u.id) === id);
const unitType = (u: Json) => hexFlag(u.info, 0, 4);
/** Bambu Studio AMSItem.cpp get_humidity_display_idx thresholds, as the printer's 1 (wet) … 5 (dry). */
const humidityIndex = (percent: number) =>
	percent < 20 ? 5 : percent < 40 ? 4 : percent < 60 ? 3 : percent < 80 ? 2 : 1;

function setDryStatus(unit: Json, status: number) {
	if (typeof unit.info === 'string') unit.info = setNibble(unit.info, 4, status);
}
function stopDrying(unit: Json) {
	unit.dry_time = 0;
	unit.dry_setting = { dry_duration: -1, dry_filament: '', dry_temperature: -1 };
}

function bambuTray(id: string, type = 'PLA', color = 'F5F5F5FF'): Json {
	return {
		id,
		state: 11,
		remain: 100,
		tag_uid: '0000000000000000',
		tray_uuid: ZERO_UUID,
		tray_id_name: type === 'PLA' ? 'A00-W1' : 'G02-W0',
		tray_info_idx: type === 'PLA' ? 'GFA00' : 'GFG02',
		tray_type: type,
		tray_sub_brands: type === 'PLA' ? 'PLA Basic' : 'PETG HF',
		tray_color: color,
		cols: [color],
		ctype: 0,
		tray_weight: '1000',
		tray_diameter: '1.75',
		nozzle_temp_min: type === 'PLA' ? '190' : '230',
		nozzle_temp_max: type === 'PLA' ? '230' : '260',
		drying_temp: type === 'PLA' ? '55' : '65',
		drying_time: '8',
		bed_temp: '0',
		bed_temp_type: '0',
		total_len: 330000,
		cali_idx: -1,
		xcam_info: '000000000000000000000000'
	};
}

export const ams: SimFeature = {
	key: 'ams',
	init(sim) {
		// Only AMS trays read tags; external spool holders have no reader.
		for (const { tray, global, unit } of sim.trays())
			if (unit && bambuIdx(tray.tray_info_idx) && tray.tray_type && isZero(tray.tray_uuid))
				tagTray(sim, tray, String(global));
	},
	command(sim, topic, msg) {
		if (topic !== 'print') return undefined;
		const s = sim.state;
		switch (msg.command) {
			case 'ams_filament_setting': {
				const tray = trayAt(sim, Number(msg.ams_id), Number(msg.slot_id ?? msg.tray_id));
				if (!tray) return { result: 'failed', reason: 'No such tray' };
				Object.assign(tray, {
					tray_info_idx: String(msg.tray_info_idx ?? ''),
					tray_type: String(msg.tray_type ?? ''),
					tray_color: String(msg.tray_color ?? 'FFFFFFFF').toUpperCase(),
					nozzle_temp_min: String(msg.nozzle_temp_min ?? 0),
					nozzle_temp_max: String(msg.nozzle_temp_max ?? 0),
					tray_sub_brands: '',
					cols: Array.isArray(msg.cols) ? msg.cols : [String(msg.tray_color ?? 'FFFFFFFF')],
					ctype: Number(msg.ctype ?? 0)
				});
				if (tray.state !== undefined && !(Number(tray.state) & 1)) tray.state = 11;
				sim.log(
					`AMS: tray ${msg.ams_id}/${msg.slot_id} set to ${tray.tray_type} ${tray.tray_color}`
				);
				sim.report();
				return { result: 'success' };
			}
			case 'ams_get_rfid': {
				const amsId = Number(msg.ams_id);
				const tray = trayAt(sim, amsId, Number(msg.slot_id));
				if (!tray) return { result: 'failed', reason: 'No such tray' };
				const global = amsId >= 128 ? amsId : amsId * 4 + Number(msg.slot_id);
				if (s.ams) s.ams.tray_reading_bits = setBit(s.ams.tray_reading_bits, global, true);
				stateOf(sim).reading.push({ global, left: 3 });
				if (bambuIdx(tray.tray_info_idx) && isZero(tray.tray_uuid))
					tagTray(sim, tray, String(global));
				sim.log(`AMS: reading the tag in tray ${global}`);
				sim.report();
				return {
					result: 'success',
					extra: { reason: 'success', ams_id: amsId, slot_id: Number(msg.slot_id) }
				};
			}
			case 'ams_user_setting': {
				if (!s.ams) return { result: 'failed', reason: 'No AMS' };
				s.ams.power_on_flag = !!msg.startup_read_option;
				s.ams.insert_flag = !!msg.tray_read_option;
				s.ams.calibrate_remain_flag = !!msg.calibrate_remain_flag;
				sim.report();
				return { result: 'success' };
			}
			case 'ams_filament_drying': {
				const unit = unitById(sim, Number(msg.ams_id));
				if (!unit) return { result: 'failed', reason: 'No such AMS' };
				const type = unitType(unit);
				if (type !== 3 && type !== 4)
					return { result: 'failed', reason: 'This AMS cannot dry filament' };
				const dry = stateOf(sim).dry;
				if (Number(msg.mode) === 0) {
					if (Number(unit.dry_time) > 0) setDryStatus(unit, 4);
					dry.set(String(unit.id), { seconds: 0, hold: 3 });
					stopDrying(unit);
					sim.log(`AMS ${unit.id}: drying stopped`);
				} else {
					const hours = Math.max(1, Math.min(24, Number(msg.duration) || 1));
					unit.dry_time = hours * 60;
					unit.dry_setting = {
						dry_duration: hours,
						dry_filament: String(msg.filament ?? ''),
						dry_temperature: Number(msg.temp) || 55
					};
					setDryStatus(unit, 1);
					dry.set(String(unit.id), { seconds: 0, hold: 5 });
					sim.log(`AMS ${unit.id}: drying at ${msg.temp} °C for ${hours} h`);
				}
				sim.report();
				return { result: 'success' };
			}
			default:
				return undefined;
		}
	},
	step(sim, seconds) {
		const st = stateOf(sim);
		const units: Json[] = sim.state.ams?.ams ?? [];
		for (const r of st.reading) r.left -= seconds;
		for (const r of st.reading.filter((x) => x.left <= 0))
			if (sim.state.ams)
				sim.state.ams.tray_reading_bits = setBit(sim.state.ams.tray_reading_bits, r.global, false);
		st.reading = st.reading.filter((r) => r.left > 0);
		for (const unit of units) {
			const d = st.dry.get(String(unit.id));
			const status = hexFlag(unit.info, 4, 4) ?? 0;
			const temp = Number(unit.temp);
			if (d) {
				d.seconds += seconds;
				if (status === 1 && (d.hold -= seconds) <= 0) setDryStatus(unit, 2);
				if (status === 2 && Number(unit.dry_time) > 0) {
					while (d.seconds >= 60 && Number(unit.dry_time) > 0) {
						d.seconds -= 60;
						unit.dry_time = Number(unit.dry_time) - 1;
						// Drier air every ten minutes of drying.
						if (unit.dry_time % 10 === 0 && Number(unit.humidity_raw) > 5)
							unit.humidity_raw = String(Number(unit.humidity_raw) - 1);
					}
					if (Number(unit.dry_time) <= 0) {
						stopDrying(unit);
						setDryStatus(unit, 3);
						d.hold = 120;
					}
				}
				if ((status === 3 || status === 4) && (d.hold -= seconds) <= 0) {
					setDryStatus(unit, 0);
					st.dry.delete(String(unit.id));
				}
			}
			// The unit warms towards its drying temperature and cools back to the room.
			if (Number.isFinite(temp) && (unitType(unit) === 3 || unitType(unit) === 4)) {
				const target =
					Number(unit.dry_time) > 0 ? Number(unit.dry_setting?.dry_temperature) || 27 : 27;
				unit.temp = (temp + (target - temp) * 0.02 * seconds).toFixed(1);
			}
		}
		// Room humidity drifts a little every half hour.
		st.humidityClock += seconds;
		if (st.humidityClock >= 1800) {
			st.humidityClock = 0;
			for (const unit of units) {
				if (Number(unit.dry_time) > 0 || unit.humidity_raw === undefined) continue;
				const next = Math.max(
					8,
					Math.min(45, Number(unit.humidity_raw) + (Math.random() < 0.5 ? -1 : 1))
				);
				unit.humidity_raw = String(next);
			}
		}
		for (const unit of units)
			if (unit.humidity_raw !== undefined)
				unit.humidity = String(humidityIndex(Number(unit.humidity_raw)));
	},
	controls: [
		{
			id: 'ams-load-bambu',
			label: 'Load a Bambu spool (RFID)',
			run(sim) {
				const trays = sim.trays().filter((t) => t.unit);
				const free =
					trays.find((t) => !t.tray.tray_type) ?? trays.find((t) => Number(t.tray.state) === 0);
				const target = free ?? trays.at(-1);
				if (!target) throw new Error('This printer has no AMS.');
				const fresh = bambuTray(
					String(target.tray.id),
					'PLA',
					['F5F5F5FF', '0A2989FF', 'C12E1FFF'][target.global % 3]
				);
				for (const k of Object.keys(target.tray)) delete target.tray[k];
				Object.assign(target.tray, fresh);
				tagTray(sim, target.tray, `${target.global}:${Date.now()}`);
				if (sim.state.ams) {
					sim.state.ams.tray_exist_bits = setBit(
						sim.state.ams.tray_exist_bits,
						target.global,
						true
					);
					sim.state.ams.tray_is_bbl_bits = setBit(
						sim.state.ams.tray_is_bbl_bits,
						target.global,
						true
					);
				}
				sim.log(`AMS: loaded a Bambu PLA Basic in tray ${target.global}`);
				sim.report();
			}
		},
		{
			id: 'ams-add-ht',
			label: 'Connect an AMS HT',
			run(sim) {
				const list: Json[] = sim.state.ams?.ams;
				if (!list) throw new Error('This printer has no AMS port.');
				const id = [128, 129, 130, 131].find((n) => !unitById(sim, n));
				if (id === undefined) throw new Error('Four AMS HT units are connected already.');
				const tray = bambuTray('0', 'PETG', '1F1F1FFF');
				tagTray(sim, tray, `ht${id}`);
				list.push({
					id: String(id),
					info: '2004', // as an X1C's AMS HT reports it (sim/states/BL-P001.json)
					humidity: '5',
					humidity_raw: '15',
					temp: '26.0',
					dry_time: 0,
					dry_setting: { dry_duration: -1, dry_filament: '', dry_temperature: -1 },
					tray: [tray]
				});
				if (sim.state.ams.ams_exist_bits !== undefined)
					sim.state.ams.ams_exist_bits = setBit(sim.state.ams.ams_exist_bits, 4 + id - 128, true);
				sim.log(`AMS: AMS HT ${id - 127} connected`);
				sim.report();
			}
		},
		{
			id: 'ams-add-unit',
			label: 'Connect another AMS',
			run(sim) {
				const list: Json[] = sim.state.ams?.ams;
				if (!list?.length) throw new Error('This printer has no AMS to copy.');
				const id = [0, 1, 2, 3].find((n) => !unitById(sim, n));
				if (id === undefined) throw new Error('Four AMS units are connected already.');
				const first = list[0];
				list.push({
					...structuredClone(first),
					id: String(id),
					...(typeof first.info === 'string' && { info: setNibble(first.info, 4, 0) }),
					dry_time: 0,
					tray: [0, 1, 2, 3].map((slot) =>
						bambuTray(
							String(slot),
							slot % 2 ? 'PETG' : 'PLA',
							['FFFFFFFF', '000000FF', 'FF6A13FF', '00AE42FF'][slot]
						)
					)
				});
				for (const t of list.at(-1).tray) tagTray(sim, t, `${id}:${t.id}`);
				if (sim.state.ams.ams_exist_bits !== undefined)
					sim.state.ams.ams_exist_bits = setBit(sim.state.ams.ams_exist_bits, id, true);
				sim.log(`AMS: unit ${id + 1} connected`);
				sim.report();
			}
		}
	]
};
