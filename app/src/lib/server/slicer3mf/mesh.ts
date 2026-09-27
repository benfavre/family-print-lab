// Meshes inside a 3MF: a fast scanner for <mesh> content (vertices, triangles and the per-triangle
// painting attributes), the canonical binary STL that names a mesh (MeshId = its sha256), and
// upstream's coordinate formatting.
import crypto from 'node:crypto';
import { writeStl, parseStl, indexed, type Soup } from '../cad/mesh';
import { parseAttrs } from './xml';
import type { MeshId, MeshRef } from '$lib/shared/slicer/project';
import { PAINT_ATTRS, PRUSA_PAINT_ATTRS, FACE_PROPERTY_ATTR, type PaintKind } from './constants';

/** Indexed geometry as the 3MF stores it. */
export interface MeshGeometry {
	vertices: Float32Array;
	triangles: Uint32Array;
}

/** A mesh read from a 3MF: geometry plus sparse per-triangle attributes. */
export interface ScannedMesh extends MeshGeometry {
	paint: Partial<Record<PaintKind, Record<number, string>>>;
	faceProperties: Record<number, string>;
}

export class MeshError extends Error {}

const VERTEX = /<vertex\b([^>]*)>/g;
const TRIANGLE = /<triangle\b([^>]*)>/g;
const NUM = (s: string | undefined) => (s === undefined ? NaN : Number(s));

/** Scans the inside of a <mesh> element. Throws on bad indices or numbers. */
export function scanMesh(xml: string): ScannedMesh {
	const verts: number[] = [];
	VERTEX.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = VERTEX.exec(xml))) {
		const a = parseAttrs(m[1]);
		const x = NUM(a.x),
			y = NUM(a.y),
			z = NUM(a.z);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
			throw new MeshError('A mesh vertex has a bad coordinate.');
		verts.push(x, y, z);
	}
	const count = verts.length / 3;
	const tris: number[] = [];
	const paint: ScannedMesh['paint'] = {};
	const faceProperties: Record<number, string> = {};
	TRIANGLE.lastIndex = 0;
	while ((m = TRIANGLE.exec(xml))) {
		const a = parseAttrs(m[1]);
		const v = [NUM(a.v1), NUM(a.v2), NUM(a.v3)];
		if (!v.every((i) => Number.isInteger(i) && i >= 0 && i < count))
			throw new MeshError('A mesh triangle points at a vertex that does not exist.');
		const t = tris.length / 3;
		tris.push(v[0], v[1], v[2]);
		for (const [kind, attr] of Object.entries(PAINT_ATTRS) as [PaintKind, string][]) {
			const value = a[attr] ?? a[PRUSA_PAINT_ATTRS[kind] ?? ''];
			if (value) (paint[kind] ??= {})[t] = value;
		}
		if (a[FACE_PROPERTY_ATTR]) faceProperties[t] = a[FACE_PROPERTY_ATTR];
	}
	return {
		vertices: Float32Array.from(verts),
		triangles: Uint32Array.from(tris),
		paint,
		faceProperties
	};
}

/** Triangle soup (9 floats per triangle) of indexed geometry. */
export function toSoup(g: MeshGeometry): Soup {
	const out = new Float32Array(g.triangles.length * 3);
	for (let i = 0; i < g.triangles.length; i++) {
		const v = g.triangles[i] * 3;
		out[i * 3] = g.vertices[v];
		out[i * 3 + 1] = g.vertices[v + 1];
		out[i * 3 + 2] = g.vertices[v + 2];
	}
	return out;
}

/** Indexed geometry of a soup: identical vertices merged, in first-use order, triangle order kept. */
export function fromSoup(soup: Soup): MeshGeometry {
	const { vertices, triangles } = indexed(soup);
	return { vertices, triangles };
}

/** A subset of triangles (first..last inclusive) with its vertices re-indexed (Prusa-style volumes). */
export function sliceTriangles(g: MeshGeometry, first: number, last: number): MeshGeometry {
	const tris = g.triangles.subarray(first * 3, (last + 1) * 3);
	const map = new Map<number, number>();
	const verts: number[] = [];
	const out = new Uint32Array(tris.length);
	for (let i = 0; i < tris.length; i++) {
		let id = map.get(tris[i]);
		if (id === undefined) {
			id = map.size;
			map.set(tris[i], id);
			const v = tris[i] * 3;
			verts.push(g.vertices[v], g.vertices[v + 1], g.vertices[v + 2]);
		}
		out[i] = id;
	}
	return { vertices: Float32Array.from(verts), triangles: out };
}

/** The canonical binary STL of a mesh (fixed header, so the same triangles always hash the same). */
export function canonicalStl(soup: Soup): Buffer {
	return writeStl(soup, 'Family Print Lab');
}

export const meshIdOf = (stl: Buffer): MeshId =>
	crypto.createHash('sha256').update(stl).digest('hex');

/** Reads a canonical STL back into indexed geometry. */
export const geometryFromStl = (stl: Buffer): MeshGeometry => fromSoup(parseStl(stl));

/** Size and bounds for a MeshRef. */
export function meshInfo(id: MeshId, g: MeshGeometry, storage: MeshRef['storage']): MeshRef {
	const min = [Infinity, Infinity, Infinity],
		max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < g.vertices.length; i++) {
		const a = i % 3;
		if (g.vertices[i] < min[a]) min[a] = g.vertices[i];
		if (g.vertices[i] > max[a]) max[a] = g.vertices[i];
	}
	const empty = g.vertices.length === 0;
	return {
		id,
		triangles: g.triangles.length / 3,
		vertices: g.vertices.length / 3,
		bbox: empty ? [0, 0, 0, 0, 0, 0] : [min[0], min[1], min[2], max[0], max[1], max[2]],
		storage
	};
}

/**
 * A float as upstream writes mesh coordinates: sprintf("%.9g") (bbs_3mf.cpp, format_coordinate in
 * _add_mesh_to_object_stream), which round-trips every float32.
 */
export function formatG9(value: number): string {
	const f = Math.fround(value);
	if (f === 0) return Object.is(f, -0) ? '-0' : '0';
	if (!Number.isFinite(f)) return String(f);
	const exp = Math.floor(Math.log10(Math.abs(f)));
	let s = f.toPrecision(9);
	// %g uses scientific notation when the exponent is below -4 or at least the precision.
	const e = s.indexOf('e');
	if (exp < -4 || exp >= 9 || e >= 0) {
		let [mant, pow] = f.toExponential(8).split('e');
		if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
		const n = Number(pow);
		pow = (n < 0 ? '-' : '+') + String(Math.abs(n)).padStart(2, '0');
		return `${mant}e${pow}`;
	}
	if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
	return s;
}

/** A number in a transform or config value: the shortest text that reads back as the same double. */
export const formatNumber = (n: number) => (Object.is(n, -0) ? '-0' : String(n));
