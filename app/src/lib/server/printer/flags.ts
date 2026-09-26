// Bit fields in Bambu reports. `fun`, `fun2`, `cfg`, `aux` and `stat` are hex strings that can be longer
// than 32 bits (MOCK-X2D.json `fun` = 40029FD1B30F9CB7), and Bambu Studio reads feature bits above
// bit 32 from them (DeviceManager.cpp ~4430–4480 get_flag_bits over stoull; fun2 bit by bit with
// get_flag_bits_no_border). So they are parsed with BigInt, never parseInt/Number.
import type { PrinterSnapshot } from '$lib/shared/printers/status';

/** A hex flag string as a BigInt, or null when absent or not hex. */
export function flagValue(hex: unknown): bigint | null {
	if (typeof hex !== 'string') return null;
	const clean = hex.trim().replace(/^0x/i, '');
	if (!clean || clean.length > 64 || !/^[0-9a-f]+$/i.test(clean)) return null;
	return BigInt(`0x${clean}`);
}

/** `count` bits starting at `bit` of a hex flag string, or null when the string is absent. */
export function hexFlag(hex: unknown, bit: number, count = 1): number | null {
	const v = flagValue(hex);
	if (v === null) return null;
	return Number((v >> BigInt(bit)) & ((1n << BigInt(count)) - 1n));
}

const bitOf = (hex: unknown, bit: number) => {
	const v = hexFlag(hex, bit);
	return v === null ? undefined : v === 1;
};

/** ha-bambulab const.py Print_Fun_Values.MQTT_SIGNATURE_REQUIRED = 0x20000000 (bit 29). */
export const FUN_SIGNATURE_REQUIRED_BIT = 29;

/**
 * Developer Mode from `fun`: bit 29 set means the printer wants signed MQTT commands, i.e. Developer
 * Mode is off and it ignores ours. Null when the printer does not send `fun`.
 */
export function developerMode(fun: unknown): boolean | null {
	const v = hexFlag(fun, FUN_SIGNATURE_REQUIRED_BIT);
	return v === null ? null : v === 0;
}

/** Feature bits the printer reports itself (Bambu Studio DeviceManager.cpp ~4430–4480, DevAxis.cpp ~15). */
export function firmwareSupport(fun: unknown, fun2: unknown): PrinterSnapshot['firmwareSupport'] {
	const out: PrinterSnapshot['firmwareSupport'] = {
		mqttBedTemp: bitOf(fun, 39), // m_support_mqtt_bet_ctrl
		mqttHoming: bitOf(fun, 32), // DevAxis.cpp m_is_support_mqtt_homing
		mqttAxis: bitOf(fun, 38), // DevAxis.cpp m_is_support_mqtt_axis_ctrl
		partSkip: bitOf(fun, 49), // is_support_partskip
		flowCalibration: bitOf(fun, 6), // is_support_flow_calibration
		paCalibration: bitOf(fun, 7), // is_support_pa_calibration
		motorNoiseCali: bitOf(fun, 10), // is_support_motor_noise_cali
		internalTimelapse: bitOf(fun, 28), // is_support_internal_timelapse
		doorOpenCheck: bitOf(fun, 12), // is_support_door_open_check
		nozzleRack: bitOf(fun, 60), // SetSupportNozzleRack
		remoteDrying: bitOf(fun2, 5), // is_support_remote_dry
		printWithEmmc: bitOf(fun2, 0) // is_support_print_with_emmc
	};
	for (const key of Object.keys(out) as (keyof typeof out)[])
		if (out[key] === undefined) delete out[key];
	return out;
}

/** ha-bambulab const.py Home_Flag_Values. */
export const HOME_FLAG = {
	SD_CARD_PRESENT: 0x00000100,
	SD_CARD_ABNORMAL: 0x00000200,
	DOOR_OPEN: 0x00800000
} as const;

/** ha-bambulab const.py Stat_Flag_Values.DOOR_OPEN (H2 series report the door in `stat`). */
export const STAT_DOOR_OPEN_BIT = 23;
