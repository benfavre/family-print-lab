// origin: BambuStudio src/libslic3r/TriangleSelector.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// Geometry of the native facet tree, without changing the model mesh's triangle ids.
// Child order: BambuStudio src/libslic3r/TriangleSelector.cpp::perform_split at
// https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/src/libslic3r/TriangleSelector.cpp
import { Triangle, Vector3 } from 'three';
import { decodePaint, type PaintNode, type PaintState } from '$lib/shared/slicer/paint';
import type { Vec3 } from './matrix';

export type Facet = [Vec3, Vec3, Vec3];
const middle = (a: Vec3, b: Vec3): Vec3 => [
	(a[0] + b[0]) / 2,
	(a[1] + b[1]) / 2,
	(a[2] + b[2]) / 2
];
export const distanceSquared = (a: Vec3, b: Vec3) =>
	(a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export function facetAt(positions: Float32Array, triangle: number): Facet {
	const vertex = (i: number): Vec3 => [
		positions[triangle * 9 + i * 3],
		positions[triangle * 9 + i * 3 + 1],
		positions[triangle * 9 + i * 3 + 2]
	];
	return [vertex(0), vertex(1), vertex(2)];
}

/** Midpoint splits in the same child order as upstream's 3MF annotation decoder. */
export function splitFacet(facet: Facet, split: 1 | 2 | 3, special: number): Facet[] {
	if (special < 0 || special > 2 || (split === 3 && special !== 0))
		throw new Error('Invalid facet split side.');
	const a = facet[special],
		b = facet[(special + 1) % 3],
		c = facet[(special + 2) % 3];
	if (split === 1) {
		const bc = middle(b, c);
		return [
			[a, b, bc],
			[bc, c, a]
		];
	}
	const ab = middle(a, b),
		ca = middle(c, a);
	if (split === 2)
		return [
			[a, ab, ca],
			[ab, b, ca],
			[b, c, ca]
		];
	const bc = middle(b, c);
	return [
		[a, ab, ca],
		[ab, b, bc],
		[bc, c, ca],
		[ab, bc, ca]
	];
}

/** A sphere/facet test includes edge and interior hits even when every corner is outside. */
export function sphereTest(point: Vec3, radius: number) {
	const centre = new Vector3(...point),
		closest = new Vector3();
	const triangle = new Triangle();
	return (facet: Facet) => {
		for (let axis = 0; axis < 3; axis++)
			if (
				point[axis] + radius < Math.min(...facet.map((v) => v[axis])) ||
				point[axis] - radius > Math.max(...facet.map((v) => v[axis]))
			)
				return false;
		triangle.a.fromArray(facet[0]);
		triangle.b.fromArray(facet[1]);
		triangle.c.fromArray(facet[2]);
		if (triangle.getArea() === 0) return false;
		triangle.closestPointToPoint(centre, closest);
		return closest.distanceToSquared(centre) <= radius * radius;
	};
}

export function visitPaintFacets(
	facet: Facet,
	node: PaintNode,
	visit: (facet: Facet, state: PaintState) => void
) {
	if (!('split' in node)) {
		visit(facet, node.state);
		return;
	}
	const children = splitFacet(facet, node.split, node.special);
	for (let i = 0; i < children.length; i++) visitPaintFacets(children[i], node.children[i], visit);
}

/** A drawing mesh only: each leaf remembers its original facet for subsequent brush picking. */
export function paintedFacets(
	positions: Float32Array,
	strings: Record<number, string> | undefined
) {
	const vertices: number[] = [],
		states: number[] = [],
		sources: number[] = [];
	for (let t = 0; t < positions.length / 9; t++) {
		const facet = facetAt(positions, t);
		const start = states.length;
		const add = (part: Facet, state: PaintState) => {
			for (const vertex of part) vertices.push(...vertex);
			states.push(state);
			sources.push(t);
		};
		try {
			visitPaintFacets(facet, strings?.[t] ? decodePaint(strings[t]) : { state: 0 }, add);
		} catch {
			// Keep unsupported imported annotations intact; draw their original facet uncoloured.
			vertices.length = start * 9;
			states.length = start;
			sources.length = start;
			add(facet, 0);
		}
	}
	return {
		positions: Float32Array.from(vertices),
		states: Uint32Array.from(states),
		sources: Uint32Array.from(sources)
	};
}
