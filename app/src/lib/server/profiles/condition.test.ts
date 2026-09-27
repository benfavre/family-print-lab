import { describe, expect, it } from 'vitest';
import { ConditionError, evaluateCondition, parseCondition } from './condition';

const printer = {
	printer_model: 'Bambu Lab A1 mini',
	printer_notes: 'Tuned. PRINTER_VENDOR_BAMBU PRINTER_HAS_BOWDEN',
	nozzle_diameter: ['0.4'],
	printable_height: '180',
	single_extruder_multi_material: '1'
};
const ok = (src: string, extra = {}) => evaluateCondition(src, printer, extra);

describe('compatible_printers_condition', () => {
	it('is true when empty, as every condition in the BBL set is at the pinned tag', () => {
		expect(ok('')).toBe(true);
		expect(ok('   ')).toBe(true);
	});

	it('compares strings and numbers, with vector indexes', () => {
		expect(ok('printer_model == "Bambu Lab A1 mini"')).toBe(true);
		expect(ok('printer_model != "Bambu Lab A1 mini"')).toBe(false);
		expect(ok('nozzle_diameter[0] == 0.4')).toBe(true);
		expect(ok('nozzle_diameter[0] > 0.3 and printable_height >= 180')).toBe(true);
		expect(ok('printable_height < 180 or nozzle_diameter[0] <> 0.4')).toBe(false);
		expect(ok('nozzle_diameter == 0.4')).toBe(true); // a vector without index reads its first value
	});

	it('matches regular expressions as PrusaSlicer-style profiles use them', () => {
		expect(ok('printer_notes=~/.*PRINTER_VENDOR_BAMBU.*/ and printer_notes!~/.*MMU.*/')).toBe(true);
		expect(ok('printer_notes =~ /.*PRINTER_VENDOR_PRUSA.*/')).toBe(false);
	});

	it('handles not, !, &&, ||, parentheses, arithmetic and functions', () => {
		expect(ok('not (printer_model == "x") && !false')).toBe(true);
		expect(ok('single_extruder_multi_material')).toBe(true);
		expect(ok('(1 + 2) * 2 == 6 || false')).toBe(true);
		expect(ok('min(nozzle_diameter[0], 0.2) == 0.2 and max(1, 2) == 2 and int(2.7) == 2')).toBe(
			true
		);
		expect(ok('one_of(printer_model, "Bambu Lab A1", /.*mini/)')).toBe(true);
		expect(ok('-1 < 0')).toBe(true);
	});

	it('reads the extra variables Bambu Studio passes (printer_preset, num_extruders)', () => {
		expect(
			ok('printer_preset == "My A1 mini" and num_extruders == 1', {
				printer_preset: 'My A1 mini',
				num_extruders: '1'
			})
		).toBe(true);
	});

	it('throws ConditionError on text it cannot read', () => {
		for (const bad of [
			'printer_model ==',
			'(1',
			'unknown_key == 1',
			'x =~ "a"',
			'"open',
			'nozzle_diameter[3] == 1',
			'nope(1)'
		])
			expect(() => ok(bad), bad).toThrow(ConditionError);
		expect(() => parseCondition('a == "b" and c[0] > 1')).not.toThrow();
		expect(() => parseCondition('a == ')).toThrow(ConditionError);
	});
});
