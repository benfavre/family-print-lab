// Facet painting in the workspace: which triangles a brush, a smart fill or an edge-bounded fill
// reaches, and the part's sparse native facet trees. A small brush subdivides annotation facets;
// the original mesh, triangle ids and unrelated painting kinds stay unchanged.
import {
	decodePaint,
	encodePaint,
	paintStates,
	paintTriangle,
	PAINT_NONE,
	type PaintState,
	type PaintNode
} from '$lib/shared/slicer/paint';
import type { Part, PaintData } from '$lib/shared/slicer/project';
import { distanceSquared, facetAt, sphereTest, splitFacet, type Facet } from './paint-geometry';
import type { Vec3 } from './matrix';

export type PaintKind = keyof PaintData;
/** Brush (a sphere), fill (the connected area painted alike) and smart fill (fill that stops at edges). */
export type PaintTool = 'brush' | 'fill' | 'edge';

export const PAINT_KIND_LABEL: Record<PaintKind, string> = {
	supports: 'Supports',
	seam: 'Seam',
	color: 'Colour',
	fuzzySkin: 'Fuzzy skin'
};

/** The capability the engine reports for each kind (shared/slicer/protocol.ts). */
export const PAINT_CAPABILITY = {
	supports: 'paint.supports',
	seam: 'paint.seam',
	color: 'paint.color',
	fuzzySkin: 'paint.fuzzy_skin'
} as const;

/** Triangle neighbours across shared edges (vertices matched by position). */
export function adjacency(positions: Float32Array): Int32Array[] {
	const count = positions.length / 9;
	// Positions to 0.1 µm, with -0 and 0 the same.
	const q = (x: number) => Math.round(x * 1e4) || 0;
	const key = (v: number) =>
		`${q(positions[v * 3])},${q(positions[v * 3 + 1])},${q(positions[v * 3 + 2])}`;
	const ids = new Map<string, number>();
	const vid = (v: number) => {
		const k = key(v);
		let id = ids.get(k);
		if (id === undefined) ids.set(k, (id = ids.size));
		return id;
	};
	const edges = new Map<string, number[]>();
	for (let t = 0; t < count; t++) {
		const v = [vid(t * 3), vid(t * 3 + 1), vid(t * 3 + 2)];
		for (let e = 0; e < 3; e++) {
			const a = v[e],
				b = v[(e + 1) % 3];
			const k = a < b ? `${a}_${b}` : `${b}_${a}`;
			const list = edges.get(k);
			if (list) list.push(t);
			else edges.set(k, [t]);
		}
	}
	const out: number[][] = Array.from({ length: count }, () => []);
	for (const list of edges.values())
		for (const a of list) for (const b of list) if (a !== b && !out[a].includes(b)) out[a].push(b);
	return out.map((l) => Int32Array.from(l));
}

function normal(positions: Float32Array, t: number): [number, number, number] {
	const p = (k: number) => positions[t * 9 + k];
	const ux = p(3) - p(0),
		uy = p(4) - p(1),
		uz = p(5) - p(2);
	const vx = p(6) - p(0),
		vy = p(7) - p(1),
		vz = p(8) - p(2);
	const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
	const len = Math.hypot(...n) || 1;
	return [n[0] / len, n[1] / len, n[2] / len];
}

/** Triangles touching the brush sphere (the mesh's own coordinates), plus the hit one. */
export function brushTriangles(
	positions: Float32Array,
	hit: number,
	point: [number, number, number],
	radius: number
): number[] {
	const out = new Set<number>([hit]);
	const touches = sphereTest(point, radius);
	for (let t = 0; t < positions.length / 9; t++) {
		if (touches(facetAt(positions, t))) out.add(t);
	}
	return [...out];
}

/**
 * Sphere painting follows TriangleSelector::select_triangle_recursive/split_triangle:
 * fully covered facets become one leaf; boundary facets split on sides above min(radius/5, 0.2).
 * Source and native child order are documented in paint-geometry.ts. Small boundary leaves keep
 * their previous state, as upstream does; this keeps painting inside the brush sphere.
 */
export function paintSphere(
	part: Pick<Part, 'paint'>,
	kind: PaintKind,
	positions: Float32Array,
	point: Vec3,
	radius: number,
	state: PaintState
): PaintData | undefined {
	if (!Number.isFinite(radius) || radius <= 0 || !point.every(Number.isFinite)) return part.paint;
	const touches = sphereTest(point, radius);
	const limit = Math.min(radius / 5, 0.2) ** 2;
	const r2 = radius * radius;
	const update = (facet: Facet, node: PaintNode, depth: number): PaintNode => {
		if (!touches(facet)) return node;
		if (facet.every((v) => distanceSquared(v, point) <= r2)) return { state };
		if (!('split' in node) && node.state === state) return node;
		if (depth >= 32) return node;
		let divided = node;
		if (!('split' in divided)) {
			// Side i is opposite vertex i; with two splits, special names the uncut side.
			const sides = [
				distanceSquared(facet[1], facet[2]),
				distanceSquared(facet[2], facet[0]),
				distanceSquared(facet[0], facet[1])
			];
			const cut = sides.flatMap((length, i) => (length > limit ? [i] : []));
			if (!cut.length) return node;
			const split = cut.length as 1 | 2 | 3;
			const special = (
				split === 3 ? 0 : split === 2 ? sides.findIndex((length) => length <= limit) : cut[0]
			) as 0 | 1 | 2;
			const previous = divided.state;
			divided = {
				split,
				special,
				children: Array.from({ length: split + 1 }, () => ({ state: previous }))
			};
		}
		const facets = splitFacet(facet, divided.split, divided.special);
		const children = divided.children.map((child, i) => update(facets[i], child, depth + 1));
		const first = children[0];
		if (
			!('split' in first) &&
			children.every((child) => !('split' in child) && child.state === first.state)
		)
			return first;
		return { ...divided, children };
	};
	const current = { ...(part.paint?.[kind] ?? {}) };
	for (let t = 0; t < positions.length / 9; t++) {
		const facet = facetAt(positions, t);
		if (!touches(facet)) continue;
		try {
			const node = update(facet, current[t] ? decodePaint(current[t]) : { state: 0 }, 0);
			if (!('split' in node) && node.state === 0) delete current[t];
			else current[t] = encodePaint(node);
		} catch {
			/* Preserve annotations this codec cannot safely edit. */
		}
	}
	const paint: PaintData = { ...part.paint };
	if (Object.keys(current).length) paint[kind] = current;
	else delete paint[kind];
	return Object.keys(paint).length ? paint : undefined;
}

/**
 * Bucket fill as upstream does it (TriangleSelector.cpp bucket_fill_select_triangles): from the hit
 * triangle across neighbours that are painted the same as it was, and with an angle limit ("smart
 * fill" edge detection) only where neighbouring triangles bend less than `maxAngle` degrees against
 * each other, so a face bounded by sharp edges fills and stops at its edges. `maxAngle` null: no limit.
 */
export function fillTriangles(
	positions: Float32Array,
	neighbours: Int32Array[],
	hit: number,
	maxAngle: number | null,
	stateOf: (triangle: number) => PaintState = () => PAINT_NONE
): number[] {
	const start = stateOf(hit);
	const limit = maxAngle === null ? -1 : Math.cos((maxAngle * Math.PI) / 180) - 1e-6;
	const seen = new Uint8Array(neighbours.length);
	const queue = [hit];
	seen[hit] = 1;
	const out: number[] = [];
	for (let q = 0; q < queue.length; q++) {
		const t = queue[q];
		out.push(t);
		const nt = normal(positions, t);
		for (const n of neighbours[t]) {
			if (seen[n] || stateOf(n) !== start) continue;
			const nn = normal(positions, n);
			const dot = Math.max(0, Math.min(1, nt[0] * nn[0] + nt[1] * nn[1] + nt[2] * nn[2]));
			if (maxAngle !== null && dot < limit) continue;
			seen[n] = 1;
			queue.push(n);
		}
	}
	return out;
}

/** The part's painting of one kind with `triangles` set to `state` (PAINT_NONE clears them). */
export function paintWith(
	part: Pick<Part, 'paint'>,
	kind: PaintKind,
	triangles: number[],
	state: PaintState
): PaintData | undefined {
	const current = { ...(part.paint?.[kind] ?? {}) };
	const text = paintTriangle(state);
	for (const t of triangles) {
		if (state === PAINT_NONE) delete current[t];
		else current[t] = text;
	}
	const paint: PaintData = { ...part.paint };
	if (Object.keys(current).length) paint[kind] = current;
	else delete paint[kind];
	return Object.keys(paint).length ? paint : undefined;
}

/**
 * The state each painted triangle shows as (a split triangle shows its most used painted state), for
 * colouring the mesh while painting.
 */
export function shownStates(strings: Record<number, string> | undefined): Map<number, PaintState> {
	const out = new Map<number, PaintState>();
	for (const [tri, text] of Object.entries(strings ?? {})) {
		try {
			const node = decodePaint(text);
			if (!('split' in node)) {
				if (node.state !== PAINT_NONE) out.set(Number(tri), node.state);
				continue;
			}
			const states = [...paintStates(node)].filter((s) => s !== PAINT_NONE);
			if (states.length) out.set(Number(tri), states[0]);
		} catch {
			// A string this codec cannot read is kept as it is and not shown.
		}
	}
	return out;
}

/** How many triangles are painted, per kind (for the object list's badges). */
export function paintCounts(part: Pick<Part, 'paint'>): Partial<Record<PaintKind, number>> {
	const out: Partial<Record<PaintKind, number>> = {};
	for (const [k, v] of Object.entries(part.paint ?? {}) as [PaintKind, Record<number, string>][])
		if (v && Object.keys(v).length) out[k] = Object.keys(v).length;
	return out;
}
