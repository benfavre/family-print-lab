import type { CutAnswer } from '$lib/shared/slicer/mesh-tools';
import type { Project, SceneObject } from '$lib/shared/slicer/project';
import { findObject, freshId } from './edit';

export function cutProblem(object: SceneObject): string | null {
	return object.parts.length !== 1 || object.parts[0].type !== 'model'
		? 'Cut supports objects with one model part. Separate parts and modifiers first.'
		: null;
}

/** Geometry-specific information cannot keep its old triangle or height references after a cut. */
export function cutDetails(object: SceneObject): boolean {
	return !!(
		object.cutInfo ||
		object.heightRanges.length ||
		object.layerHeightProfile?.length ||
		object.parts.some(
			(p) => p.paint || p.faceProperties || p.text || p.xml?.length || p.primitive || p.source
		)
	);
}

function replaceMesh(object: SceneObject, mesh: CutAnswer['pieces'][number]['mesh']) {
	object.parts[0].mesh = mesh.id;
	for (const part of object.parts) {
		delete part.paint;
		delete part.faceProperties;
		delete part.text;
		delete part.xml;
		delete part.primitive;
		delete part.source;
		delete part.uuid;
	}
	delete object.cutInfo;
	delete object.layerHeightProfile;
	object.heightRanges = [];
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
	if (cutDetails(object) && !clearDetails)
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
			const taken = project.objects.flatMap((o) => [
				o.id,
				...o.parts.map((p) => p.id),
				...o.instances.map((i) => i.id)
			]);
			taken.push(next.id);
			next.parts[0].id = freshId(`${next.id}-p`, taken);
			taken.push(next.parts[0].id);
			delete next.parts[0].sourceId;
			next.instances = original.instances.map((instance) => {
				const id = freshId(`${next.id}-i`, taken);
				taken.push(id);
				return { id, transform: [...instance.transform], printable: instance.printable };
			});
			project.objects.push(next);
			for (const plate of project.plates)
				for (const link of [...plate.instances]) {
					if (link.objectId !== original.id) continue;
					const k = original.instances.findIndex((i) => i.id === link.instanceId);
					if (k >= 0) plate.instances.push({ objectId: next.id, instanceId: next.instances[k].id });
				}
		}
		next.name = `${original.name} (${piece.side})`;
		replaceMesh(next, piece.mesh);
		project.meshes[piece.mesh.id] = piece.mesh;
		made.push(next.id);
	}
	return made;
}
