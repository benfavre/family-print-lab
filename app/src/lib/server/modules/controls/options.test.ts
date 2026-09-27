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
	});
});
