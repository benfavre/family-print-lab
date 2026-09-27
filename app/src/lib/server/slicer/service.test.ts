import { describe, expect, it } from 'vitest';
import type { ResolvedBundle } from '$lib/shared/slicer/profiles';
import { PLATES } from '$lib/shared/domain';
import { bedTypeFor } from './profile-book';
import { applyOverrides, jobOverrides } from './service';

const preset = (
	kind: 'printer' | 'process' | 'filament',
	config: Record<string, string | string[]>
) => ({
	kind,
	name: kind,
	chain: [kind],
	config,
	origin: Object.fromEntries(Object.keys(config).map((k) => [k, kind]))
});

describe('job settings on top of the presets', () => {
	it('turns the job into process and filament overrides', () => {
		expect(
			jobOverrides({
				model: 'C12',
				nozzle: '0.4',
				layerHeight: '0.20',
				material: 'PLA',
				supports: 'Tree',
				infill: 22.4,
				plate: 'Textured PEI',
				color: 'ff7a2f'
			})
		).toEqual({
			process: { sparse_infill_density: '22%', enable_support: '1', support_type: 'tree(auto)' },
			filaments: [{ filament_colour: ['#FF7A2F'] }]
		});
		const plain = jobOverrides({
			model: 'N1',
			nozzle: '0.4',
			layerHeight: '0.20',
			material: 'PLA',
			supports: 'None',
			infill: null,
			plate: 'Cool plate',
			color: 'not a colour'
		});
		expect(plain).toEqual({ process: { enable_support: '0' }, filaments: [{}] });
	});

	it('keeps the combined config the backend resolved and puts overrides on top', () => {
		const bundle: ResolvedBundle = {
			printer: preset('printer', { nozzle_diameter: ['0.4'] }),
			process: preset('process', { sparse_infill_density: '15%' }),
			filaments: [
				preset('filament', { filament_colour: ['#FFFFFF'] }),
				preset('filament', { filament_colour: ['#000000'] })
			],
			// Upstream's full_config has keys no single preset has.
			full: {
				nozzle_diameter: ['0.4'],
				sparse_infill_density: '15%',
				filament_colour: ['#FFFFFF', '#000000'],
				filament_map: ['1', '1']
			},
			vendor: { tag: 'v02.08.02.61', version: '02.08.00.05' }
		};
		const out = applyOverrides(bundle, {
			process: { sparse_infill_density: '40%' },
			filaments: [{}, { filament_colour: ['#FF7A2F'] }]
		});
		expect(out.full).toEqual({
			nozzle_diameter: ['0.4'],
			sparse_infill_density: '40%',
			filament_colour: ['#FFFFFF', '#FF7A2F'],
			filament_map: ['1', '1']
		});
		expect(out.process.config.sparse_infill_density).toBe('40%');
		expect(out.process.origin.sparse_infill_density).toBe('job');
		expect(out.filaments[1].config.filament_colour).toEqual(['#FF7A2F']);
		expect(bundle.full.sparse_infill_density).toBe('15%');
	});
});

describe('the job’s build plate', () => {
	it('names each plate the way Bambu Studio’s curr_bed_type does', () => {
		expect(PLATES.map(bedTypeFor)).toEqual([
			'Textured PEI Plate',
			'High Temp Plate',
			'Cool Plate',
			'Engineering Plate',
			'Textured PEI Plate'
		]);
		expect(bedTypeFor('Cool Plate SuperTack')).toBe('Supertack Plate');
		expect(bedTypeFor('')).toBe('Textured PEI Plate');
	});
});
