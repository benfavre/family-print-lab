import type { CutAnswer } from '$lib/shared/slicer/mesh-tools';
import type { Project, SceneObject } from '$lib/shared/slicer/project';
import { findObject, freshId } from './edit';
import { hasGeometryDetails, replaceGeometry } from './geometry-details';
export { hasGeometryDetails as cutDetails } from './geometry-details';

export function cutProblem(object: SceneObject): string | null {
	return object.parts.length !== 1 || object.parts[0].type !== 'model'
		? 'Cut supports objects with one model part. Separate parts and modifiers first.'
		: null;
}

/** Keep placement, settings and plate links. Two halves become separately selectable objects. */
export function applyCut(
	project: Project,
	objectId: string,
	sourceMesh: string,
	answer: CutAnswer,
	clearDetails: boolean
): string[] {
	const object = findObject(project, objectId);
	const problem = cutProblem(object);
	if (problem) throw new Error(problem);
	if (object.parts[0].mesh !== sourceMesh)
		throw new Error('The mesh changed while cutting. Try again.');
	if (hasGeometryDetails(object) && !clearDetails)
		throw new Error('Allow clearing the geometry details before cutting.');
	if (!answer.pieces.length || answer.pieces.length > 2)
		throw new Error('The cut did not produce valid pieces.');
	const original = structuredClone(object);
	const made: string[] = [];
	for (const [index, piece] of answer.pieces.entries()) {
		const next = index ? structuredClone(original) : object;
		if (index) {
			next.id = freshId(
				'o',
				project.objects.flatMap((o) => [
					o.id,
					...o.parts.map((p) => p.id),
					...o.instances.map((i) => i.id)
				])
			);
			delete next.sourceId;
			next.parts[0].id = `${next.id}-p1`;
			delete next.parts[0].sourceId;
			next.instances = original.instances.map((instance, k) => ({
				id: `${next.id}-i${k + 1}`,
				transform: [...instance.transform],
				printable: instance.printable
			}));
			project.objects.push(next);
			for (const plate of project.plates)
				for (const link of [...plate.instances]) {
					if (link.objectId !== original.id) continue;
					const k = original.instances.findIndex((i) => i.id === link.instanceId);
					if (k >= 0) plate.instances.push({ objectId: next.id, instanceId: next.instances[k].id });
				}
		}
		next.name = `${original.name} (${piece.side})`;
		replaceGeometry(next, piece.mesh);
		project.meshes[piece.mesh.id] = piece.mesh;
		made.push(next.id);
	}
	return made;
}
