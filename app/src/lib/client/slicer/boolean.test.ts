import { describe, expect, it } from 'vitest';
import { emptyProject, type MeshRef } from '$lib/shared/slicer/project';
import { addObject } from './edit';
import { applyBoolean, booleanProblem } from './boolean';
import { hasGeometryDetails } from './geometry-details';
const mesh = (id: string): MeshRef => ({
	id: id.repeat(64),
	triangles: 12,
	vertices: 8,
	bbox: [-5, -5, -5, 5, 5, 5],
	storage: { kind: 'file', path: `${id}.stl` }
});
function fixture() {
	const p = emptyProject({
		printer: { kind: 'printer', name: '', source: 'project' },
		process: { kind: 'process', name: '', source: 'project' },
		filaments: []
	});
	const bed = {
		area: [0, 0, 256, 256] as [number, number, number, number],
		height: 250,
		printerModel: ''
	};
	const a = addObject(p, { name: 'A', mesh: mesh('a'), plate: 1, bed });
	const b = addObject(p, { name: 'B', mesh: mesh('b'), plate: 1, bed });
	a.config.wall_loops = '4';
	a.parts[0].filament = 2;
	return { p, a, b };
}
describe('boolean project edits', () => {
	it('keeps primary placement and settings and removes secondary links', () => {
		const { p, a, b } = fixture();
		const before = structuredClone(a);
		applyBoolean(p, a.id, b.id, [mesh('a').id, mesh('b').id], mesh('c'), false);
		expect(p.objects).toHaveLength(1);
		expect(a.instances).toEqual(before.instances);
		expect(a.parts[0].transform).toEqual(before.parts[0].transform);
		expect(a.config).toEqual(before.config);
		expect(a.parts[0].filament).toBe(2);
		expect(p.plates[0].instances).toEqual([{ objectId: a.id, instanceId: a.instances[0].id }]);
	});
	it('requires consent before invalidating annotations and refuses stale or ambiguous inputs', () => {
		const { p, a, b } = fixture();
		a.parts[0].paint = { color: { 0: '4' } };
		const before = structuredClone(p);
		expect(() =>
			applyBoolean(p, a.id, b.id, [mesh('a').id, mesh('b').id], mesh('c'), false)
		).toThrow('clearing');
		expect(p).toEqual(before);
		expect(() =>
			applyBoolean(p, a.id, b.id, [mesh('d').id, mesh('b').id], mesh('c'), true)
		).toThrow('changed');
		expect(booleanProblem([a, a])).toContain('different');
		b.instances.push({ ...b.instances[0], id: 'copy' });
		expect(booleanProblem([a, b])).toContain('one copy');
		b.instances.pop();
		applyBoolean(p, a.id, b.id, [mesh('a').id, mesh('b').id], mesh('c'), true);
		expect(hasGeometryDetails(a)).toBe(false);
	});
});
