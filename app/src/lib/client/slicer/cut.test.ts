import { describe, expect, it } from 'vitest';
import { emptyProject, IDENTITY, type MeshRef } from '$lib/shared/slicer/project';
import { addObject } from './edit';
import { applyCut, cutDetails, cutProblem } from './cut';
import { translation } from './matrix';

const mesh = (id: string): MeshRef => ({
	id: id.repeat(64),
	triangles: 12,
	vertices: 8,
	bbox: [-5, -5, -5, 5, 5, 5],
	storage: { kind: 'file', path: `${id}.stl` }
});
function fixture() {
	const project = emptyProject({
		printer: { kind: 'printer', name: '', source: 'project' },
		process: { kind: 'process', name: '', source: 'project' },
		filaments: []
	});
	const object = addObject(project, {
		name: 'Cube',
		mesh: mesh('a'),
		plate: 1,
		bed: { area: [0, 0, 256, 256], height: 250, printerModel: '' }
	});
	object.parts[0].transform = translation(3, 4, 5);
	object.config = { wall_loops: '4' };
	object.parts[0].config = { sparse_infill_density: '30%' };
	object.parts[0].filament = 2;
	object.instances.push({
		id: 'copy',
		transform: translation(25, 30, 5),
		printable: false,
		identifyId: 11
	});
	project.plates.push({
		index: 2,
		name: '',
		locked: false,
		config: {},
		instances: [{ objectId: object.id, instanceId: 'copy' }]
	});
	return { project, object };
}
const answer = {
	pieces: [
		{ side: 'below' as const, mesh: mesh('b') },
		{ side: 'above' as const, mesh: mesh('c') }
	]
};
describe('cut project edits', () => {
	it('keeps transforms, settings, filaments and every plate link while making independent halves', () => {
		const { project, object } = fixture();
		const before = structuredClone(object);
		const ids = applyCut(project, object.id, mesh('a').id, answer, false);
		expect(ids).toHaveLength(2);
		for (const result of project.objects) {
			expect(result.parts[0].transform).toEqual(before.parts[0].transform);
			expect(result.instances.map((i) => i.transform)).toEqual(
				before.instances.map((i) => i.transform)
			);
			expect(result.config).toEqual(before.config);
			expect(result.parts[0].config).toEqual(before.parts[0].config);
			expect(result.parts[0].filament).toBe(2);
		}
		expect(project.plates.map((p) => p.instances.length)).toEqual([2, 2]);
		expect(project.objects[1].instances.every((i) => i.identifyId === undefined)).toBe(true);
		expect(project.objects.map((o) => o.parts[0].mesh)).toEqual([mesh('b').id, mesh('c').id]);
	});
	it('requires explicit consent before clearing geometry details and preserves the draft on refusal', () => {
		const { project, object } = fixture();
		object.parts[0].paint = { supports: { 0: '4' } };
		object.parts[0].text = { text: 'hello' };
		object.parts[0].faceProperties = { 0: 'face' };
		object.parts[0].xml = ['<mesh_stat/>'];
		object.layerHeightProfile = [0, 0.2, 10, 0.2];
		object.heightRanges = [{ minZ: 0, maxZ: 2, config: { layer_height: '0.1' } }];
		object.cutInfo = '<cut/>';
		const before = structuredClone(project);
		expect(cutDetails(object)).toBe(true);
		expect(() => applyCut(project, object.id, mesh('a').id, answer, false)).toThrow('clearing');
		expect(project).toEqual(before);
		applyCut(project, object.id, mesh('a').id, answer, true);
		for (const part of project.objects) expect(cutDetails(part)).toBe(false);
	});
	it('refuses stale results and objects with modifiers; one retained half keeps the original id', () => {
		const { project, object } = fixture();
		expect(() => applyCut(project, object.id, mesh('d').id, answer, false)).toThrow('changed');
		object.parts.push({
			id: 'modifier',
			mesh: mesh('a').id,
			type: 'modifier',
			name: '',
			transform: [...IDENTITY],
			config: {}
		});
		expect(cutProblem(object)).toContain('one model part');
		object.parts.pop();
		expect(
			applyCut(project, object.id, mesh('a').id, { pieces: [answer.pieces[1]] }, false)
		).toEqual([object.id]);
		expect(project.objects).toHaveLength(1);
		expect(project.plates.map((p) => p.instances.length)).toEqual([1, 1]);
	});
	it('does not reuse child ids already present under a different object', () => {
		const { project, object } = fixture();
		object.parts[0].id = 'o2-p1';
		const old = object.instances[0].id;
		object.instances[0].id = 'o2-i1';
		project.plates[0].instances.find((i) => i.instanceId === old)!.instanceId = 'o2-i1';
		applyCut(project, object.id, mesh('a').id, answer, false);
		const ids = project.objects.flatMap((o) => [
			o.id,
			...o.parts.map((p) => p.id),
			...o.instances.map((i) => i.id)
		]);
		expect(new Set(ids).size).toBe(ids.length);
		const made = project.objects[1];
		expect(project.plates[0].instances).toContainEqual({
			objectId: made.id,
			instanceId: made.instances[0].id
		});
	});
});
