import type { Project, SceneObject } from '$lib/shared/slicer/project';
import type { SimplifyAnswer } from '$lib/shared/slicer/simplify';
import { findObject } from './edit';
import { compose } from './matrix';
import { hasGeometryDetails, replaceGeometry } from './geometry-details';

export function simplifyProblem(object: SceneObject): string | null {
	return object.parts.length !== 1 || object.parts[0].type !== 'model'
		? 'Simplify supports objects with one model part. Separate parts and modifiers first.'
		: null;
}

/** Bound displacement in project millimetres for every copy, including nonuniform scale/shear. */
export function localSimplifyTolerance(object: SceneObject, tolerance: number): number {
	if (!Number.isFinite(tolerance) || tolerance < 0.001 || tolerance > 5)
		throw new Error('Choose a surface change between 0.001 and 5 mm.');
	let scale = 0;
	for (const instance of object.instances) {
		const t = compose(object.parts[0].transform, instance.transform);
		// The spectral norm is at most sqrt(matrix 1-norm * matrix infinity-norm).
		const columns = [0, 3, 6].map((i) => Math.abs(t[i]) + Math.abs(t[i + 1]) + Math.abs(t[i + 2]));
		const rows = [0, 1, 2].map((i) => Math.abs(t[i]) + Math.abs(t[i + 3]) + Math.abs(t[i + 6]));
		scale = Math.max(scale, Math.sqrt(Math.max(...columns) * Math.max(...rows)));
	}
	if (!Number.isFinite(scale) || scale <= 0) throw new Error('The object has no usable scale.');
	return tolerance / scale;
}

export function applySimplify(
	project: Project,
	objectId: string,
	sourceMesh: string,
	answer: SimplifyAnswer,
	clearDetails: boolean
) {
	const object = findObject(project, objectId);
	const problem = simplifyProblem(object);
	if (problem) throw new Error(problem);
	if (object.parts[0].mesh !== sourceMesh)
		throw new Error('The mesh changed while simplifying. Try again.');
	if (hasGeometryDetails(object) && !clearDetails)
		throw new Error('Allow clearing the geometry details before simplifying.');
	if (answer.after >= answer.before || answer.mesh.id === sourceMesh) return;
	if (answer.after <= 0 || answer.after !== answer.mesh.triangles)
		throw new Error('Simplifying did not produce a valid mesh.');
	replaceGeometry(object, answer.mesh);
	project.meshes[answer.mesh.id] = answer.mesh;
}

interface EditableProject {
	readonly project: Project;
	change(label: string, edit: (draft: Project) => void): boolean;
}

/** Reject responses after an edit, undo, navigation or cancellation; never overwrite newer work. */
export async function simplifyObject(
	workspace: EditableProject,
	objectId: string,
	tolerance: number,
	clearDetails: boolean,
	signal: AbortSignal,
	request: typeof fetch = fetch
): Promise<SimplifyAnswer> {
	const before = workspace.project;
	const object = findObject(before, objectId);
	const problem = simplifyProblem(object);
	if (problem) throw new Error(problem);
	if (hasGeometryDetails(object) && !clearDetails)
		throw new Error('Allow clearing the geometry details before simplifying.');
	const meshId = object.parts[0].mesh;
	signal.throwIfAborted();
	const response = await request('/api/slicer-ui/meshes/simplify', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ meshId, tolerance: localSimplifyTolerance(object, tolerance) }),
		signal
	});
	const answer = await response.json();
	if (!response.ok) throw new Error(answer.error ?? 'The object could not be simplified.');
	signal.throwIfAborted();
	if (workspace.project !== before)
		throw new Error('The project changed while simplifying. Try again.');
	if (answer.after < answer.before && answer.mesh.id !== meshId) {
		if (
			!workspace.change('Simplify object', (draft) =>
				applySimplify(draft, objectId, meshId, answer, clearDetails)
			)
		)
			throw new Error('The simplified mesh could not be applied.');
	}
	return answer as SimplifyAnswer;
}
