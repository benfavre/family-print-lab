import { describe, expect, it } from 'vitest';
import { emptyProject, type MeshRef } from '$lib/shared/slicer/project';
import { addObject } from './edit';
import { applyText } from './text';
const mesh = (id: string): MeshRef => ({
	id: id.repeat(64),
	triangles: 12,
	vertices: 8,
	bbox: [-5, -5, -5, 5, 5, 5],
	storage: { kind: 'file', path: `${id}.stl` }
});
describe('text project edits', () => {
	it('preserves placements and settings while requiring explicit annotation clearing', () => {
		const project = emptyProject({
			printer: { kind: 'printer', name: '', source: 'project' },
			process: { kind: 'process', name: '', source: 'project' },
			filaments: []
		});
		const object = addObject(project, {
			name: 'A',
			mesh: mesh('a'),
			plate: 1,
			bed: { area: [0, 0, 256, 256], height: 250, printerModel: '' }
		});
		object.config.wall_loops = '4';
		object.parts[0].filament = 2;
		object.parts[0].paint = { supports: { 0: '4' } };
		const before = structuredClone(object);
		expect(() => applyText(project, object.id, mesh('a').id, mesh('b'), false)).toThrow('clearing');
		expect(object).toEqual(before);
		expect(() => applyText(project, object.id, mesh('c').id, mesh('b'), true)).toThrow('changed');
		applyText(project, object.id, mesh('a').id, mesh('b'), true);
		expect(object.instances).toEqual(before.instances);
		expect(object.parts[0].transform).toEqual(before.parts[0].transform);
		expect(object.parts[0].filament).toBe(2);
		expect(object.config).toEqual(before.config);
		expect(object.parts[0].paint).toBeUndefined();
	});
});
