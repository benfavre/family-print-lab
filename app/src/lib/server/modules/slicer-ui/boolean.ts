// Combine in the first mesh's coordinate system, so its part and instance placements stay intact.
import { Matrix4 } from 'three';
import type { Soup } from '../../cad/mesh';
import { AppError } from '../../validation';
import type { Transform } from '$lib/shared/slicer/project';
import type { BooleanMode } from '$lib/shared/slicer/boolean';
import { load, soupOf, toSolid, type Solid } from './mesh-tools';

function matrix(t: Transform) {
	if (t.length !== 12 || !t.every(Number.isFinite))
		throw new AppError(400, 'The objects need finite transforms.');
	const matrix = new Matrix4().set(
		t[0],
		t[3],
		t[6],
		t[9],
		t[1],
		t[4],
		t[7],
		t[10],
		t[2],
		t[5],
		t[8],
		t[11],
		0,
		0,
		0,
		1
	);
	if (Math.abs(matrix.determinant()) < 1e-12)
		throw new AppError(400, 'An object has a zero scale and cannot be combined.');
	return matrix;
}
export async function booleanMesh(
	first: Soup,
	second: Soup,
	firstTransform: Transform,
	secondTransform: Transform,
	mode: BooleanMode
): Promise<Soup> {
	const relative = matrix(firstTransform).invert().multiply(matrix(secondTransform));
	const w = await load();
	const owned: Solid[] = [];
	const keep = (value: Solid) => {
		owned.push(value);
		return value;
	};
	try {
		const a = keep(toSolid(w, first)),
			source = keep(toSolid(w, second));
		const b = keep(source.transform(relative.toArray() as Parameters<Solid['transform']>[0]));
		const result = keep(
			mode === 'union' ? a.add(b) : mode === 'subtract' ? a.subtract(b) : a.intersect(b)
		);
		if (result.isEmpty())
			throw new AppError(
				400,
				'That combination leaves nothing. Move the objects or choose another operation.'
			);
		return soupOf(result);
	} finally {
		for (const value of owned.reverse()) value.delete();
	}
}
