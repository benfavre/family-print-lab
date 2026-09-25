import { describe, expect, it } from 'vitest';
import { chooseProfiles, findSlicer, slice } from './slicer';
import { readSliced } from './printer/sliced';
import { renderScad } from './cad/openscad';
import { writeStl } from './cad/mesh';

const slicer = findSlicer();

// Runs where Bambu Studio is installed (this computer); skipped elsewhere.
describe.runIf(slicer.available)('slicing with Bambu Studio', () => {
	it('picks X2D profiles from the job’s settings', () => {
		const pick = (material: string, layerHeight = '0.20', plate = 'Textured PEI') =>
			chooseProfiles(slicer.path!, {
				nozzle: '0.4',
				layerHeight,
				material,
				supports: 'None',
				infill: 15,
				plate
			});
		expect(pick('PLA')).toMatchObject({
			machine: 'Bambu Lab X2D 0.4 nozzle',
			process: '0.20mm Standard @BBL X2D',
			filament: 'Bambu PLA Basic @BBL X2D 0.4 nozzle',
			bedType: 'Textured PEI Plate'
		});
		expect(pick('PLA Matte').filament).toMatch(/PLA Matte/);
		expect(pick('PETG', '0.16', 'Smooth PEI')).toMatchObject({
			process: '0.16mm Standard @BBL X2D',
			bedType: 'High Temp Plate'
		});
		expect(pick('PETG').filament).toMatch(/PETG/);
	});

	it('slices a part into a file the printer accepts: X2D model code, time, weight, colour and picture', async () => {
		const cube = await renderScad('cube([20, 20, 10]);');
		const png = Buffer.from('89504e470d0a1a0a', 'hex');
		const r = await slice({
			stl: writeStl(cube.soup!),
			name: 'Test cube',
			thumbnail: png,
			settings: {
				nozzle: '0.4',
				layerHeight: '0.20',
				material: 'PLA',
				supports: 'None',
				infill: 15,
				plate: 'Textured PEI',
				color: '#ff7a2f'
			}
		});
		expect(r.minutes).toBeGreaterThan(0);
		expect(r.grams).toBeGreaterThan(0);
		const file = readSliced(r.data);
		expect(file.printerModelId).toBe('N6');
		expect(file.plates[0]).toMatchObject({ index: 1, layers: 50 });
		expect(file.plates[0].filaments[0]).toMatchObject({ type: 'PLA', color: '#FF7A2F' });
		expect(file.thumbnails.get(1)?.equals(png)).toBe(true);
	}, 120_000);
});
