// Print options (print_option) as the printer reports them. The typed snapshot has no field for these,
// so they are read from the raw report the way Bambu Studio does: bits in `home_flag` on every printer
// (DevPrintOptions.cpp ParseDetectionV1_0, DeviceManager.cpp parse_home_flag ~1073), overridden by `cfg`
// on printers that send it and supported-bits in `fun` (ParseDetectionV2_0 ~180–250), at v02.08.02.61.
import { hexFlag } from '$lib/server/printer/flags';
import type { Capabilities } from '$lib/shared/printers/models';
import type { PrintOptions } from '$lib/shared/controls';

type Raw = Record<string, unknown>;

const bit = (n: number | null, b: number) => (n === null ? null : ((n >>> b) & 1) === 1);

export function parsePrintOptions(raw: Raw, caps: Capabilities): PrintOptions {
	const home =
		typeof raw.home_flag === 'number' && Number.isFinite(raw.home_flag) ? raw.home_flag : null;
	const cfg = (b: number) => {
		const v = hexFlag(raw.cfg, b);
		return v === null ? null : v === 1;
	};
	const fun = (b: number) => hexFlag(raw.fun, b) === 1;
	const hasAms = Array.isArray((raw.ams as Raw | undefined)?.ams)
		? ((raw.ams as Raw).ams as unknown[]).length > 0
		: false;
	const pick = (fromCfg: boolean | null, fromHome: boolean | null) => fromCfg ?? fromHome;
	return {
		autoRecovery: {
			supported: true,
			enabled:
				pick(cfg(16), bit(home, 4)) ??
				(typeof raw.auto_recovery === 'boolean' ? raw.auto_recovery : null)
		},
		sound: {
			supported: caps.promptSound || !!bit(home, 18) || fun(8),
			enabled: pick(cfg(22), bit(home, 17))
		},
		filamentTangle: {
			supported: !!bit(home, 19) || fun(9),
			enabled: pick(cfg(23), bit(home, 20))
		},
		nozzleBlob: {
			supported: !!bit(home, 25) || fun(13),
			enabled: pick(cfg(24), bit(home, 24))
		},
		airPrint: { supported: !!bit(home, 29), enabled: bit(home, 28) },
		autoSwitchFilament: { supported: hasAms, enabled: pick(cfg(18), bit(home, 10)) }
	};
}
