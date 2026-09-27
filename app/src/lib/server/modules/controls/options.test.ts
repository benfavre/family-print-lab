import { describe, expect, it } from 'vitest';
import { parsePrintOptions } from './options';
import { capabilitiesFor } from '$lib/shared/printers/models';

const bits = (...b: number[]) => b.reduce((n, x) => n | (1 << x), 0);

describe('print options from the report', () => {
	it('reads home_flag bits on printers without cfg (Bambu Studio ParseDetectionV1_0)', () => {
		const o = parsePrintOptions(
			{ home_flag: bits(4, 17, 18, 19, 25, 29, 28), ams: { ams: [{ id: '0' }] } },
			capabilitiesFor('C12', null)
		);
		expect(o.autoRecovery).toEqual({ supported: true, enabled: true });
		expect(o.sound).toEqual({ supported: true, enabled: true });
		expect(o.filamentTangle).toEqual({ supported: true, enabled: false });
		expect(o.nozzleBlob).toEqual({ supported: true, enabled: false });
		expect(o.airPrint).toEqual({ supported: true, enabled: true });
		expect(o.autoSwitchFilament).toEqual({ supported: true, enabled: false });
	});

	it('lets cfg win and takes support from fun (ParseDetectionV2_0)', () => {
		// cfg bits 16 (auto recovery) and 23 (tangle) set; home_flag says the opposite.
		const cfg = ((1 << 16) | (1 << 23)).toString(16);
		const fun = ((1 << 9) | (1 << 13)).toString(16);
		const o = parsePrintOptions({ home_flag: bits(20, 24), cfg, fun }, capabilitiesFor('N6', null));
		expect(o.autoRecovery.enabled).toBe(true);
		expect(o.filamentTangle).toEqual({ supported: true, enabled: true });
		expect(o.nozzleBlob).toEqual({ supported: true, enabled: false });
		expect(o.autoSwitchFilament.supported).toBe(false);
	});

	it('handles the negative home_flag values real printers send and missing fields', () => {
		const o = parsePrintOptions({ home_flag: -1066967905 }, capabilitiesFor('N6', null));
		expect(o.autoRecovery.enabled).toBe(((-1066967905 >>> 4) & 1) === 1);
		const empty = parsePrintOptions({}, capabilitiesFor('C11', null));
		expect(empty.autoRecovery).toEqual({ supported: true, enabled: null });
		expect(empty.sound.supported).toBe(false);
		expect(empty.doorCheck).toEqual({ supported: false, mode: null });
	});

	it('takes support from fun over home_flag, and support_* booleans over both', () => {
		// home_flag says sound and tangle are supported; fun (bits 8, 9 clear) says they are not.
		const o = parsePrintOptions(
			{ home_flag: bits(18, 19), fun: '0' },
			capabilitiesFor('C12', null)
		);
		expect(o.sound.supported).toBe(false);
		expect(o.filamentTangle.supported).toBe(false);
		const explicit = parsePrintOptions(
			{ fun: '0', support_prompt_sound: true, support_auto_recovery_step_loss: false },
			capabilitiesFor('C12', null)
		);
		expect(explicit.sound.supported).toBe(true);
		expect(explicit.autoRecovery.supported).toBe(false);
		// auto_recovery beats home_flag; cfg beats both.
		expect(
			parsePrintOptions({ home_flag: bits(4), auto_recovery: false }, capabilitiesFor('C12', null))
				.autoRecovery.enabled
		).toBe(false);
	});

	it('reads the door-open check from fun bit 12 and cfg bits 20–21', () => {
		const fun = (1 << 12).toString(16);
		const pause = parsePrintOptions(
			{ fun, cfg: (2 << 20).toString(16) },
			capabilitiesFor('N6', null)
		);
		expect(pause.doorCheck).toEqual({ supported: true, mode: 2 });
		const warn = parsePrintOptions(
			{ fun, cfg: (1 << 20).toString(16) },
			capabilitiesFor('N6', null)
		);
		expect(warn.doorCheck.mode).toBe(1);
		expect(
			parsePrintOptions({ fun: '1', cfg: '0' }, capabilitiesFor('N9', null)).doorCheck
		).toEqual({
			supported: false,
			mode: 0
		});
	});
});
