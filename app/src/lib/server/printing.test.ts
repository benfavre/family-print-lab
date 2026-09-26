import { describe, expect, it } from 'vitest';
import { projectMapping } from './printing';

const f = (id: number) => ({ id, type: 'PLA', color: '#ffffff', grams: 1, meters: 1 });

describe('project_file mapping', () => {
	it('puts each tray at its filament id, with -1 for filaments the plate does not use', () => {
		const sliced = { plates: [{ filaments: [f(1), f(2)] }, { filaments: [f(2), f(4)] }] };
		// Plate 2 uses filaments 2 and 4 of the project's four.
		expect(projectMapping(sliced, sliced.plates[1], [5, 128])).toEqual([-1, 5, -1, 128]);
		expect(projectMapping(sliced, sliced.plates[0], [0, 1])).toEqual([0, 1, -1, -1]);
	});

	it('keeps the mapping as given when the file names no filament ids', () => {
		const plate = { filaments: [f(0)] };
		expect(projectMapping({ plates: [plate] }, plate, [3])).toEqual([3]);
		expect(projectMapping({ plates: [] }, { filaments: [] }, [])).toEqual([]);
	});
});
