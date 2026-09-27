import { describe, expect, it, vi } from 'vitest';
import { emptyProject, type MeshRef } from '$lib/shared/slicer/project';
import type { SimplifyAnswer } from '$lib/shared/slicer/simplify';
import { addObject } from './edit';
import { translation } from './matrix';
import { hasGeometryDetails } from './geometry-details';
import { applySimplify, localSimplifyTolerance, simplifyObject } from './simplify';

const mesh = (id: string, triangles = 100): MeshRef => ({
	id: id.repeat(64),
	triangles,
	vertices: 52,
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
		name: 'Sphere',
		mesh: mesh('a'),
		plate: 1,
		bed: { area: [0, 0, 256, 256], height: 250, printerModel: '' }
	});
	object.parts[0].transform = translation(3, 4, 5);
	object.parts[0].filament = 2;
	object.parts[0].config = { wall_loops: '3' };
	object.config = { sparse_infill_density: '20%' };
	object.instances.push({
		id: 'copy',
		transform: [2, 0, 0, 0, 3, 0, 0, 0, 4, 50, 60, 70],
		printable: false
	});
	return { project, object };
}
const answer: SimplifyAnswer = { mesh: mesh('b', 40), before: 100, after: 40 };

describe('simplifying workspace objects', () => {
	it('keeps every transform, placement, filament and setting while clearing old geometry metadata with consent', () => {
		const { project, object } = fixture();
		object.parts[0].paint = { supports: { 0: '4' } };
		object.parts[0].source = { source_file: 'old.stl' };
		object.parts[0].text = { text: 'Old text' };
		object.parts[0].faceProperties = { 0: 'old' };
		object.layerHeightProfile = [0, 0.2, 10, 0.1];
		const before = structuredClone(project);
		expect(() => applySimplify(project, object.id, mesh('a').id, answer, false)).toThrow(
			'clearing'
		);
		expect(project).toEqual(before);
		applySimplify(project, object.id, mesh('a').id, answer, true);
		expect(hasGeometryDetails(object)).toBe(false);
		expect(object.parts[0].mesh).toBe(answer.mesh.id);
		expect(object.parts[0].transform).toEqual(before.objects[0].parts[0].transform);
		expect(object.instances).toEqual(before.objects[0].instances);
		expect(object.config).toEqual(before.objects[0].config);
		expect(object.parts[0].config).toEqual(before.objects[0].parts[0].config);
		expect(object.parts[0].filament).toBe(2);
		expect(project.plates).toEqual(before.plates);
	});
	it('bounds surface displacement for all scaled copies and rejects invalid limits', () => {
		const { object } = fixture();
		expect(localSimplifyTolerance(object, 0.1)).toBeCloseTo(0.025);
		object.instances[1].transform[3] = 2; // shear raises the upper bound
		expect(localSimplifyTolerance(object, 0.1)).toBeLessThan(0.025);
		for (const tolerance of [0, NaN, 10])
			expect(() => localSimplifyTolerance(object, tolerance)).toThrow('surface change');
	});
	it('ignores unchanged results without an edit and refuses stale or cancelled async responses', async () => {
		const { project, object } = fixture();
		const workspace = { project, change: vi.fn(() => true) };
		const unchanged = { mesh: mesh('a'), before: 100, after: 100 };
		const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(unchanged));
		await simplifyObject(workspace, object.id, 0.1, false, new AbortController().signal, request);
		expect(workspace.change).not.toHaveBeenCalled();
		for (const cancel of [false, true]) {
			let finish!: (response: Response) => void;
			request.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					})
			);
			const controller = new AbortController();
			const pending = simplifyObject(workspace, object.id, 0.1, false, controller.signal, request);
			if (cancel) controller.abort();
			else workspace.project = structuredClone(workspace.project);
			finish(Response.json(answer));
			await expect(pending).rejects.toThrow(cancel ? /abort/i : /project changed/i);
		}
		expect(workspace.change).not.toHaveBeenCalled();
	});
	it('applies a current response as a single undoable change and leaves geometry intact on server failure', async () => {
		const { project, object } = fixture();
		const workspace = {
			project,
			change: vi.fn((_label: string, edit: (draft: typeof project) => void) => {
				const draft = structuredClone(workspace.project);
				edit(draft);
				workspace.project = draft;
				return true;
			})
		};
		const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(answer));
		await simplifyObject(workspace, object.id, 0.1, false, new AbortController().signal, request);
		expect(workspace.change).toHaveBeenCalledTimes(1);
		expect(workspace.change.mock.calls[0][0]).toBe('Simplify object');
		expect(workspace.project.objects[0].parts[0].mesh).toBe(answer.mesh.id);
		const before = structuredClone(workspace.project);
		request.mockResolvedValueOnce(Response.json({ error: 'Mesh not watertight' }, { status: 422 }));
		await expect(
			simplifyObject(workspace, object.id, 0.1, false, new AbortController().signal, request)
		).rejects.toThrow('watertight');
		expect(workspace.project).toEqual(before);
	});
});
