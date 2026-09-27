// Coordinate-preserving solid operations for the workspace. Workbench edits intentionally drop
// models onto the bed; here meshes stay in their original local coordinates and instances stay put.
import Module from 'manifold-3d';
import { indexed, type Soup } from '../../cad/mesh';
import { AppError } from '../../validation';
import type { CutRequest } from '$lib/shared/slicer/mesh-tools';

type Wasm = Awaited<ReturnType<typeof Module>>;
type Solid = InstanceType<Wasm['Manifold']>;
let loaded: Promise<Wasm> | undefined;
const load = () =>
	(loaded ??= Module().then((w) => {
		w.setup();
		return w;
	}));

/** Pull a project-space plane back through the complete affine transform. No mesh baking or drop. */
export function localCutPlane({
	transform: t,
	axis,
	at
}: Pick<CutRequest, 'transform' | 'axis' | 'at'>) {
	if (t.length !== 12 || !t.every(Number.isFinite) || !Number.isFinite(at))
		throw new AppError(400, 'The cut needs finite coordinates.');
	const k = { x: 0, y: 1, z: 2 }[axis];
	const normal: [number, number, number] = [t[k], t[k + 3], t[k + 6]];
	const length = Math.hypot(...normal);
	const determinant =
		t[0] * (t[4] * t[8] - t[5] * t[7]) -
		t[3] * (t[1] * t[8] - t[2] * t[7]) +
		t[6] * (t[1] * t[5] - t[2] * t[4]);
	if (length < 1e-12 || Math.abs(determinant) < 1e-12)
		throw new AppError(400, 'The object has a zero scale and cannot be cut.');
	return {
		normal: normal.map((n) => n / length) as [number, number, number],
		offset: (at - t[9 + k]) / length
	};
}

function soupOf(solid: Solid): Soup {
	const { numProp, vertProperties: v, triVerts: t } = solid.getMesh();
	const soup = new Float32Array(t.length * 3);
	for (let i = 0; i < t.length; i++)
		for (let k = 0; k < 3; k++) soup[i * 3 + k] = v[t[i] * numProp + k];
	return soup;
}

export async function cutMesh(
	soup: Soup,
	request: Pick<CutRequest, 'transform' | 'axis' | 'at' | 'keep'>
) {
	const plane = localCutPlane(request);
	const w = await load();
	const { vertices, triangles } = indexed(soup);
	const mesh = new w.Mesh({ numProp: 3, vertProperties: vertices, triVerts: triangles });
	mesh.merge();
	let original: Solid;
	try {
		original = new w.Manifold(mesh);
	} catch {
		throw new AppError(
			422,
			'This mesh is not watertight. Repair it in the model workbench before cutting.'
		);
	}
	const solids: Solid[] = [original];
	try {
		const [above, below] = original.splitByPlane(plane.normal, plane.offset);
		solids.push(above, below);
		if (above.isEmpty() || below.isEmpty())
			throw new AppError(400, 'That plane does not cut through the object.');
		return (['below', 'above'] as const)
			.filter((side) => request.keep === 'both' || request.keep === side)
			.map((side) => ({ side, soup: soupOf(side === 'above' ? above : below) }));
	} finally {
		for (const solid of solids.reverse()) solid.delete();
	}
}
