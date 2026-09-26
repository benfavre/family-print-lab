import { describe, expect, it } from 'vitest';
import { externalMapping, projectMapping } from './printing';
import { fakeSliced, readSliced } from './printer/sliced';

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

describe('external spools on dual-nozzle printers', () => {
	const e = (id: number, extruder?: 1 | 2) => ({ ...f(id), extruder });

	it('sends each filament to its own nozzle’s external spool when the AMS is not used', () => {
		// Filament 1 on the left nozzle (deputy, 254), 3 on the right (main, 255); 2 is not on this plate.
		const plate = { filaments: [e(1, 1), e(3, 2)] };
		const sliced = { plates: [plate, { filaments: [e(2, 1)] }] };
		expect(externalMapping(sliced, plate, 2)).toEqual([254, -1, 255]);
	});

	it('leaves single-nozzle printers and files without nozzle maps empty', () => {
		const plate = { filaments: [e(1, 1)] };
		expect(externalMapping({ plates: [plate] }, plate, 1)).toEqual([]);
		const unknown = { filaments: [e(1)] };
		expect(externalMapping({ plates: [unknown] }, unknown, 2)).toEqual([]);
	});

	it('reads the nozzle of each filament from slice_info', () => {
		const file = readSliced(
			fakeSliced({
				minutes: 5,
				grams: 3,
				printerModelId: 'O1D',
				filaments: [
					{ type: 'PLA', color: '#FFFFFF', grams: 1 },
					{ type: 'PETG', color: '#000000', grams: 2 }
				],
				filamentMaps: [2, 1]
			})
		);
		expect(file.plates[0].filaments.map((x) => x.extruder)).toEqual([2, 1]);
		expect(
			readSliced(fakeSliced({ minutes: 5, grams: 3 })).plates[0].filaments[0]
		).not.toHaveProperty('extruder');
	});
});
