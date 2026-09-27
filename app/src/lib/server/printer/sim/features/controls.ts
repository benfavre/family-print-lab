// Simulated printer controls (the controls package): the commands defs/controls.ts sends, answered and
// reflected in the report the way the real firmware shows them (spd_lvl, lights_report, packed
// temperatures, fan speeds and airduct parts, extruder state, tray_now/snow, s_obj, home_flag/cfg option
// bits, xcam). G-code lines are read for M104, M140, M141, M106 and G28 only. Values the firmware does
// not document (the speed percentages, how long a calibration step takes) are the simulator's own.
import { EXT_DEPUTY, EXT_MAIN } from '$lib/shared/printers/status';
import type { Json, SimFeature, SimPrinter } from '../core';

/** Simulator speed percentages per level (spd_mag; not taken from a real printer). */
const SPEED_MAG: Record<number, number> = { 1: 50, 2: 100, 3: 124, 4: 166 };
/** Calibration steps played out, by option bit (stage ids from ha-bambulab CURRENT_STAGE_IDS). */
const CALIBRATION_STAGES: [number, number][] = [
	[1 << 0, 12], // micro lidar
	[1 << 1, 1], // bed levelling
	[1 << 2, 3], // vibration compensation
	[1 << 3, 25] // motor noise
];
const STAGE_SECONDS = 120;
/** features/core.ts logs at most this much of a gcode_line. */
const CORE_GCODE_LOG_LIMIT = 200;
/** Fan part ids (Bambu Studio DevFan.h AIR_FUN) → the classic report field. */
const FAN_FIELDS: Record<number, string> = {
	1: 'cooling_fan_speed',
	2: 'big_fan1_speed',
	3: 'big_fan2_speed'
};
/** Option bits in home_flag and cfg (Bambu Studio DevPrintOptions.cpp ParseDetectionV1_0/V2_0, DeviceManager.cpp parse_home_flag). */
const OPTION_BITS: Record<string, { home: number; cfg: number | null }> = {
	auto_recovery: { home: 4, cfg: 16 },
	sound_enable: { home: 17, cfg: 22 },
	filament_tangle_detect: { home: 20, cfg: 23 },
	nozzle_blob_detect: { home: 24, cfg: 24 },
	air_print_detect: { home: 28, cfg: null },
	auto_switch_filament: { home: 10, cfg: 18 }
};

interface ControlState {
	calibration: number[];
	stageLeft: number;
	skipped: number;
}
const states = new WeakMap<SimPrinter, ControlState>();
const stateOf = (sim: SimPrinter) => {
	let st = states.get(sim);
	if (!st) states.set(sim, (st = { calibration: [], stageLeft: 0, skipped: 0 }));
	return st;
};

const extruders = (s: Json): Json[] | null =>
	Array.isArray(s.device?.extruder?.info) ? s.device.extruder.info : null;
const activeNozzle = (s: Json) => ((s.device?.extruder?.state ?? 0) >> 4) & 0xf;
const packed = (now: number, target: number) =>
	(Math.round(target) << 16) | Math.max(0, Math.round(now));
const busy = (sim: SimPrinter) => ['PREPARE', 'RUNNING', 'PAUSE'].includes(sim.state.gcode_state);

function setNozzleTarget(sim: SimPrinter, target: number, nozzle = activeNozzle(sim.state)) {
	const list = extruders(sim.state);
	const e = list?.find((x) => x.id === nozzle);
	if (!list || !e || nozzle === activeNozzle(sim.state))
		return sim.setTemps({ nozzleTarget: target });
	e.temp = packed(e.temp & 0xffff, target);
}

function setChamberTarget(sim: SimPrinter, target: number) {
	const ctc = sim.state.device?.ctc?.info;
	if (ctc && typeof ctc.temp === 'number') ctc.temp = packed(ctc.temp & 0xffff, target);
	else throw new Error('This printer cannot heat its chamber');
}

/** Raw fan steps 0–15 that read back as `percent` (report.ts fanPercent rounds up to 10 %). */
const fanRaw = (percent: number) => Math.floor((percent * 15) / 100);

function setFan(sim: SimPrinter, index: number, percent: number) {
	const s = sim.state;
	const field = FAN_FIELDS[index];
	if (field) s[field] = String(fanRaw(percent));
	const part = (s.device?.airduct?.parts ?? []).find((p: Json) => p.id === index << 4);
	if (part) part.state = percent;
	if (!field && !part) throw new Error(`Fan ${index} is not on this printer`);
}

function setOption(sim: SimPrinter, field: string, on: boolean) {
	const s = sim.state;
	const bits = OPTION_BITS[field];
	const flag = Number(s.home_flag ?? 0);
	s.home_flag = on ? flag | (1 << bits.home) : flag & ~(1 << bits.home);
	if (bits.cfg !== null && typeof s.cfg === 'string') {
		const mask = 1n << BigInt(bits.cfg);
		const cfg = BigInt(`0x${s.cfg}`);
		s.cfg = (on ? cfg | mask : cfg & ~mask).toString(16).toUpperCase();
	}
	if (field === 'auto_recovery' && 'auto_recovery' in s) s.auto_recovery = on;
}

/** The tray ams_change_filament names, as a global tray (see GlobalTray). */
function trayFor(sim: SimPrinter, msg: Json): number {
	const ams = Number(msg.ams_id);
	const slot = Number(msg.slot_id);
	if (ams === EXT_MAIN || ams === EXT_DEPUTY)
		// Older printers call their only external spool 254 (Bambu Studio on_ams_load_curr).
		return Array.isArray(sim.state.vir_slot) ? ams : EXT_MAIN;
	if (ams >= 128) return ams;
	if (ams === 16) return 24 + slot;
	return ams * 4 + slot;
}

function gcode(sim: SimPrinter, line: string) {
	const [code, ...args] = line.trim().toUpperCase().split(/\s+/);
	const arg = (letter: string) => {
		const a = args.find((x) => x.startsWith(letter));
		return a === undefined ? null : Number(a.slice(1));
	};
	const s = arg('S');
	if (code === 'M104' && s !== null) setNozzleTarget(sim, s);
	else if (code === 'M140' && s !== null) sim.setTemps({ bedTarget: s });
	else if (code === 'M141' && s !== null) setChamberTarget(sim, s);
	else if (code === 'M106' && s !== null)
		setFan(sim, arg('P') ?? 1, Math.round((s / 255) * 10) * 10);
	else if (code === 'G28') sim.log('⌂ homing (simulated)');
}

function handle(
	sim: SimPrinter,
	topic: string,
	msg: Json
): ReturnType<NonNullable<SimFeature['command']>> {
	const s = sim.state;
	if (topic === 'system' && msg.command === 'ledctrl') {
		const list: Json[] = Array.isArray(s.lights_report) ? s.lights_report : (s.lights_report = []);
		const light = list.find((l) => l.node === msg.led_node);
		if (!light) return { result: 'failed', reason: `No ${msg.led_node} on this printer` };
		light.mode = msg.led_mode;
		return { result: 'success' };
	}
	if (topic === 'system' && msg.command === 'set_door_stat') {
		// Door-open check in cfg bits 20–21 (Bambu Studio DeviceManager.cpp ~4421), where fun bit 12 says so.
		const mode = Number(msg.config);
		if (
			typeof s.cfg !== 'string' ||
			typeof s.fun !== 'string' ||
			!((BigInt(`0x${s.fun}`) >> 12n) & 1n)
		)
			return { result: 'failed', reason: 'No door check on this printer' };
		if (![0, 1, 2].includes(mode)) return { result: 'failed', reason: 'Unknown door check' };
		s.cfg = ((BigInt(`0x${s.cfg}`) & ~(3n << 20n)) | (BigInt(mode) << 20n))
			.toString(16)
			.toUpperCase();
		return { result: 'success' };
	}
	if (topic === 'xcam' && msg.command === 'xcam_control_set') {
		s.xcam ??= {};
		s.xcam[msg.module_name] = !!msg.control;
		if (msg.halt_print_sensitivity) s.xcam.halt_print_sensitivity = msg.halt_print_sensitivity;
		return { result: 'success' };
	}
	if (topic !== 'print') return undefined;
	switch (msg.command) {
		case 'print_speed': {
			const level = Number(msg.param);
			if (!SPEED_MAG[level]) return { result: 'failed', reason: 'Unknown speed' };
			s.spd_lvl = level;
			s.spd_mag = SPEED_MAG[level];
			return { result: 'success' };
		}
		case 'set_nozzle_temp':
			setNozzleTarget(sim, Number(msg.target_temp), Number(msg.extruder_index));
			return { result: 'success' };
		case 'set_bed_temp':
			sim.setTemps({ bedTarget: Number(msg.temp) });
			return { result: 'success' };
		case 'set_ctt':
			setChamberTarget(sim, Number(msg.ctt_val));
			return { result: 'success' };
		case 'set_fan':
			setFan(sim, Number(msg.fan_index), Number(msg.speed));
			return { result: 'success' };
		case 'set_airduct': {
			const duct = s.device?.airduct;
			if (!duct?.modeList?.some((m: Json) => m.modeId === msg.modeId))
				return { result: 'failed', reason: 'Unknown airduct mode' };
			duct.modeCur = msg.modeId;
			return { result: 'success' };
		}
		case 'back_to_center':
			sim.log('⌂ homing (simulated)');
			return { result: 'success' };
		case 'xyz_ctrl':
			sim.log(`↔ ${msg.axis} ${msg.dir > 0 ? '+' : '−'}${msg.mode ? 10 : 1} mm (simulated)`);
			return { result: 'success' };
		case 'set_extrusion_length':
			sim.log(`⇵ extruder ${msg.extruder_index}: ${msg.length} mm (simulated)`);
			return { result: 'success' };
		case 'select_extruder': {
			const ext = s.device?.extruder;
			if (!ext || busy(sim)) return { result: 'failed', reason: 'Cannot switch nozzles now' };
			ext.state = (ext.state & ~0xf0) | ((Number(msg.extruder_index) & 0xf) << 4);
			return { result: 'success' };
		}
		case 'buzzer_ctrl':
			sim.log(`🔔 buzzer mode ${msg.mode} (simulated)`);
			return { result: 'success' };
		case 'ams_change_filament': {
			if (busy(sim)) return { result: 'failed', reason: 'The printer is busy' };
			if (Number(msg.target) === 255 && Number(msg.slot_id) === 255) {
				sim.setActiveTray(null);
				sim.log('⏏ filament unloaded (simulated)');
				return { result: 'success' };
			}
			const global = trayFor(sim, msg);
			const tray = sim.trays().find((t) => t.global === global);
			if (!tray?.tray?.tray_type) return { result: 'failed', reason: 'That tray is empty' };
			sim.setActiveTray(global);
			sim.log(`⇥ loaded tray ${global} (simulated)`);
			return { result: 'success' };
		}
		case 'calibration': {
			if (busy(sim)) return { result: 'failed', reason: 'The printer is busy' };
			const option = Number(msg.option) || 0;
			const st = stateOf(sim);
			st.calibration = CALIBRATION_STAGES.filter(([bit]) => option & bit).map(([, id]) => id);
			st.stageLeft = STAGE_SECONDS;
			s.stg_cur = st.calibration[0] ?? 255;
			s.print_type = 'system';
			return { result: 'success' };
		}
		case 'skip_objects': {
			const job = sim.job;
			if (!job || !['RUNNING', 'PAUSE'].includes(s.gcode_state))
				return { result: 'failed', reason: 'Nothing is printing' };
			const ids = (Array.isArray(msg.obj_list) ? msg.obj_list : []).map(Number);
			const before: number[] = Array.isArray(s.s_obj) ? s.s_obj : [];
			const added = ids.filter((id: number) => !before.includes(id));
			s.s_obj = [...before, ...added];
			// Each skipped object shortens what is left (simulated: a tenth each).
			for (let i = 0; i < added.length; i++)
				job.seconds = Math.max(job.elapsed + 1, job.seconds - (job.seconds - job.elapsed) * 0.1);
			stateOf(sim).skipped += added.length;
			return { result: 'success' };
		}
		case 'print_option':
			for (const field of Object.keys(OPTION_BITS))
				if (typeof msg[field] === 'boolean') setOption(sim, field, msg[field]);
			return { result: 'success' };
		default:
			return undefined;
	}
}

export const controls: SimFeature = {
	key: 'controls',
	init(sim) {
		// The core feature answers gcode_line and logs it as "G-code: a · b"; read those lines too.
		const log = sim.log;
		sim.log = (m: string) => {
			log(m);
			const text = m.match(/^G-code: (.*)$/)?.[1];
			if (!text) return;
			const lines = text.split(' · ');
			// The core cuts the logged text at 200 characters; a cut last line ("M104 S2") is not run.
			if (text.length >= CORE_GCODE_LOG_LIMIT) lines.pop();
			for (const line of lines)
				try {
					gcode(sim, line);
				} catch (error) {
					log(`✕ ${line}: ${(error as Error).message}`);
				}
			sim.report();
		};
	},
	command(sim, topic, msg) {
		const out = handle(sim, topic, msg);
		// Report the change before the answer goes out, so the app sees it when the reply arrives.
		if (out && out !== 'silent' && out.result === 'success') sim.report();
		return out;
	},
	step(sim) {
		const s = sim.state;
		const j = sim.job;
		// Speed levels scale how fast the print advances (the core adds one second after this).
		if (j && s.gcode_state === 'RUNNING') j.elapsed += (SPEED_MAG[s.spd_lvl] ?? 100) / 100 - 1;
		if (!j && Array.isArray(s.s_obj) && s.s_obj.length) s.s_obj = [];
		// The chamber heater and nozzles that are not in use follow their targets too.
		const ctc = s.device?.ctc?.info;
		if (ctc && typeof ctc.temp === 'number') {
			const target = (ctc.temp >> 16) & 0xffff;
			const now = sim.temps().chamber;
			if (target > now) sim.setTemps({ chamber: now + (target - now) * 0.02 });
		}
		for (const e of extruders(s) ?? [])
			if (e.id !== activeNozzle(s)) {
				const now = e.temp & 0xffff;
				const target = (e.temp >> 16) & 0xffff;
				e.temp = packed(now + (Math.max(target, 25) - now) * 0.18, target);
			}
		// Calibration: one stage after another.
		const st = states.get(sim);
		if (st?.calibration.length && !j) {
			if (--st.stageLeft <= 0) {
				st.calibration.shift();
				st.stageLeft = STAGE_SECONDS;
				s.stg_cur = st.calibration[0] ?? 255;
				if (!st.calibration.length) {
					s.print_type = 'idle';
					sim.log('✓ calibration done (simulated)');
				}
			}
		}
	}
};
