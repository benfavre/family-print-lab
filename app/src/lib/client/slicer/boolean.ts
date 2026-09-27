import type { MeshRef, Project, SceneObject } from '$lib/shared/slicer/project';
import { findObject, removeObjects } from './edit';
import { hasGeometryDetails, replaceGeometry } from './geometry-details';

export function booleanProblem(objects: SceneObject[]): string | null {
	if (objects.length !== 2 || objects[0].id === objects[1].id)
		return 'Select two different objects.';
	if (
		objects.some(
			(o) => o.parts.length !== 1 || o.parts[0].type !== 'model' || o.instances.length !== 1
		)
	)
		return 'Combine supports two objects with one model part and one copy each.';
	return null;
}
export function applyBoolean(
	project: Project,
	firstId: string,
	secondId: string,
	sourceMeshes: [string, string],
	mesh: MeshRef,
	clearDetails: boolean
) {
	const first = findObject(project, firstId),
		second = findObject(project, secondId);
	const problem = booleanProblem([first, second]);
	if (problem) throw new Error(problem);
	if (first.parts[0].mesh !== sourceMeshes[0] || second.parts[0].mesh !== sourceMeshes[1])
		throw new Error('A mesh changed while combining. Try again.');
	if ([first, second].some(hasGeometryDetails) && !clearDetails)
		throw new Error('Allow clearing the geometry details before combining.');
	replaceGeometry(first, mesh);
	project.meshes[mesh.id] = mesh;
	removeObjects(project, [secondId]);
}
