// Print options (print_option) as the printer reports them. The typed snapshot has no field for these,
// so they are read from the raw report the way Bambu Studio does: bits in `home_flag` on every printer
// (DevPrintOptions.cpp ParseDetectionV1_0, DeviceManager.cpp parse_home_flag ~1073), overridden by `cfg`
// on printers that send it, support bits in `fun` replacing the home_flag ones when `fun` is sent, and
// explicit support_* booleans last (ParseDetectionV2_0 ~180–290), at v02.08.02.61. The door-open check
// is DeviceManager.cpp ~4421 (cfg bits 20–21) and ~4453 (fun bit 12).
import { hexFlag } from '$lib/server/printer/flags';
import type { Capabilities } from '$lib/shared/printers/models';
import type { DoorCheck, PrintOptions } from '$lib/shared/controls';

type Raw = Record<string, unknown>;

const bit = (n: number | null, b: number) => (n === null ? null : ((n >>> b) & 1) === 1);
const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);

export function parsePrintOptions(raw: Raw, caps: Capabilities): PrintOptions {
	const home =
		typeof raw.home_flag === 'number' && Number.isFinite(raw.home_flag) ? raw.home_flag : null;
	const cfg = (b: number) => {
		const v = hexFlag(raw.cfg, b);
		return v === null ? null : v === 1;
	};
	// Bambu Studio reads support from `fun` only when it is a non-empty string, and then it wins.
	const hasFun = typeof raw.fun === 'string' && raw.fun !== '' && hexFlag(raw.fun, 0) !== null;
	const support = (homeBit: number, funBit: number, explicit: unknown, fallback = false) =>
		flag(explicit) ??
		(hasFun ? hexFlag(raw.fun, funBit) === 1 : home !== null ? !!bit(home, homeBit) : fallback);
	const hasAms = Array.isArray((raw.ams as Raw | undefined)?.ams)
		? ((raw.ams as Raw).ams as unknown[]).length > 0
		: false;
	const pick = (fromCfg: boolean | null, fromHome: boolean | null) => fromCfg ?? fromHome;
	const door = hexFlag(raw.cfg, 20, 2);
	return {
		autoRecovery: {
			// Shown unless the printer says it cannot (support_auto_recovery_step_loss).
			supported: flag(raw.support_auto_recovery_step_loss) ?? true,
			enabled: cfg(16) ?? flag(raw.auto_recovery) ?? bit(home, 4)
		},
		sound: {
			supported: support(18, 8, raw.support_prompt_sound, caps.promptSound),
			enabled: pick(cfg(22), bit(home, 17))
		},
		filamentTangle: {
			supported: support(19, 9, raw.support_filament_tangle_detect),
			enabled: pick(cfg(23), bit(home, 20))
		},
		nozzleBlob: { supported: support(25, 13, undefined), enabled: pick(cfg(24), bit(home, 24)) },
		airPrint: { supported: !!bit(home, 29), enabled: bit(home, 28) },
		autoSwitchFilament: { supported: hasAms, enabled: pick(cfg(18), bit(home, 10)) },
		doorCheck: {
			supported: hexFlag(raw.fun, 12) === 1,
			mode: door === null || door > 2 ? null : (door as DoorCheck)
		}
	};
}
