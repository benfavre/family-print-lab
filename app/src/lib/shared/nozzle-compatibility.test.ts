import { describe, expect, it } from 'vitest';
import { nozzleProblems, type NozzleRequirements } from './nozzle-compatibility';

const filament = (extruder?: 1 | 2) => ({
	id: 1,
	type: 'PLA',
	color: '#FFFFFF',
	grams: 1,
	meters: 0.1,
	extruder
});
const dual: NozzleRequirements = {
	nozzleDiameters: [0.6, 0.4],
	filaments: [filament(1), filament(2)]
};
const installed = [
	{ id: 0, diameter: 0.4 },
	{ id: 1, diameter: 0.6 }
];

describe('nozzle diameter compatibility', () => {
	it('compares a sole nozzle without treating filament_map 1 as the left side', () => {
		const plate = { nozzleDiameters: [0.6], filaments: [filament(1)] };
		expect(nozzleProblems(plate, [{ id: 0, diameter: 0.6 }], 1)).toEqual([]);
		expect(nozzleProblems(plate, [{ id: 0, diameter: 0.4 }], 1)[0]).toContain(
			'needs a 0.6 mm nozzle'
		);
	});
	it('reverses dual config indices to physical ids, regardless of report array order', () => {
		expect(nozzleProblems(dual, installed, 2)).toEqual([]);
		expect(nozzleProblems(dual, [...installed].reverse(), 2)).toEqual([]);
		const wrong = nozzleProblems(
			dual,
			[
				{ id: 0, diameter: 0.6 },
				{ id: 1, diameter: 0.4 }
			],
			2
		);
		expect(wrong).toHaveLength(2);
		expect(wrong[0]).toContain('0.6 mm left nozzle');
		expect(wrong[1]).toContain('0.4 mm right nozzle');
	});
	it('checks only nozzles used by this plate, not another configured nozzle', () => {
		const plate = { ...dual, filaments: [filament(2)] };
		expect(
			nozzleProblems(
				plate,
				[
					{ id: 0, diameter: 0.4 },
					{ id: 1, diameter: 0.2 }
				],
				2
			)
		).toEqual([]);
	});
	it('preserves known positions when one requirement is nil and tolerates numeric round-off', () => {
		expect(
			nozzleProblems(
				{ ...dual, nozzleDiameters: [null, 0.4] },
				[
					{ id: 0, diameter: 0.40000001 },
					{ id: 1, diameter: 0.2 }
				],
				2
			)
		).toEqual([]);
		expect(nozzleProblems({ ...dual, nozzleDiameters: [null, 0.6] }, installed, 2)[0]).toContain(
			'right nozzle'
		);
	});
	it('does not guess absent, invalid, ambiguous or dynamically assigned requirements', () => {
		for (const plate of [
			{ filaments: [filament(1)] },
			{ ...dual, nozzleDiameters: [0.4] },
			{ ...dual, filaments: [filament()] },
			{ ...dual, dynamicNozzleMapping: true }
		])
			expect(nozzleProblems(plate, installed, 2)).toEqual([]);
		for (const diameter of [null, 0, -0.4, NaN, Infinity]) {
			expect(
				nozzleProblems({ nozzleDiameters: [0.6], filaments: [] }, [{ id: 0, diameter }], 1)
			).toEqual([]);
		}
		expect(nozzleProblems(dual, undefined, 2)).toEqual([]);
	});
});
