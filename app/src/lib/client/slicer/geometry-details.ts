import type { MeshRef, SceneObject } from '$lib/shared/slicer/project';

/** Geometry-specific information cannot keep its old triangle or height references after replacing a mesh. */
export function hasGeometryDetails(object: SceneObject): boolean {
	return !!(
		object.cutInfo ||
		object.heightRanges.length ||
		object.layerHeightProfile?.length ||
		object.parts.some(
			(p) => p.paint || p.faceProperties || p.text || p.xml?.length || p.primitive || p.source
		)
	);
}

export function replaceGeometry(object: SceneObject, mesh: MeshRef) {
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
