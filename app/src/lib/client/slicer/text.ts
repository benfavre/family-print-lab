import type { MeshRef, Project } from '$lib/shared/slicer/project';
import { findObject } from './edit';
import { hasGeometryDetails, replaceGeometry } from './geometry-details';
export function applyText(
	project: Project,
	objectId: string,
	sourceMesh: string,
	mesh: MeshRef,
	clearDetails: boolean
) {
	const object = findObject(project, objectId);
	if (object.parts.length !== 1 || object.parts[0].type !== 'model')
		throw new Error('Text supports objects with one model part.');
	if (object.parts[0].mesh !== sourceMesh)
		throw new Error('The mesh changed while making text. Try again.');
	if (hasGeometryDetails(object) && !clearDetails)
		throw new Error('Allow clearing the geometry details before adding text.');
	replaceGeometry(object, mesh);
	project.meshes[mesh.id] = mesh;
}
