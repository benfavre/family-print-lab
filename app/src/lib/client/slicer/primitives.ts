// The shapes Bambu Studio offers as generated modifiers (Add modifier → Box, Cylinder, Sphere), as
// triangle soups centred on the origin, and a binary STL writer to store them like any other mesh.
import type { Primitive } from './edit';

/** Default sizes in mm (the object's size is used when known). */
export const PRIMITIVE_LABEL: Record<Primitive, string> = {
	box: 'Box',
	cylinder: 'Cylinder',
	sphere: 'Sphere'
};

export function primitiveSoup(
	kind: Primitive,
	size: [number, number, number],
	segments = 32
): Float32Array {
	const [sx, sy, sz] = size.map((v) => v / 2);
	const tris: number[] = [];
	const tri = (a: number[], b: number[], c: number[]) => tris.push(...a, ...b, ...c);
	if (kind === 'box') {
		const v = (x: number, y: number, z: number) => [x * sx, y * sy, z * sz];
		const quad = (a: number[], b: number[], c: number[], d: number[]) => (
			tri(a, b, c),
			tri(a, c, d)
		);
		quad(v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1)); // bottom (normal -z)
		quad(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)); // top
		quad(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)); // front (-y)
		quad(v(1, 1, -1), v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1)); // back
		quad(v(-1, 1, -1), v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1)); // left (-x)
		quad(v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)); // right
	} else if (kind === 'cylinder') {
		const ring = (i: number, z: number) => {
			const a = (i / segments) * Math.PI * 2;
			return [Math.cos(a) * sx, Math.sin(a) * sy, z];
		};
		for (let i = 0; i < segments; i++) {
			const a0 = ring(i, -sz),
				a1 = ring(i + 1, -sz),
				b0 = ring(i, sz),
				b1 = ring(i + 1, sz);
			tri(a0, a1, b1);
			tri(a0, b1, b0);
			tri([0, 0, sz], b0, b1);
			tri([0, 0, -sz], a1, a0);
		}
	} else {
		const rings = Math.max(4, segments / 2);
		const p = (r: number, s: number) => {
			const theta = (r / rings) * Math.PI;
			const phi = (s / segments) * Math.PI * 2;
			return [
				Math.sin(theta) * Math.cos(phi) * sx,
				Math.sin(theta) * Math.sin(phi) * sy,
				-Math.cos(theta) * sz
			];
		};
		for (let r = 0; r < rings; r++)
			for (let s = 0; s < segments; s++) {
				const a = p(r, s),
					b = p(r, s + 1),
					c = p(r + 1, s + 1),
					d = p(r + 1, s);
				if (r > 0) tri(a, b, c);
				if (r < rings - 1) tri(a, c, d);
			}
	}
	return Float32Array.from(tris);
}

/** Binary STL (normals left zero: slicers work them out). */
export function binaryStl(soup: Float32Array, name = 'Family Print Lab'): ArrayBuffer {
	const count = soup.length / 9;
	const buf = new ArrayBuffer(84 + count * 50);
	const view = new DataView(buf);
	const header = new TextEncoder().encode(name.slice(0, 79));
	new Uint8Array(buf, 0, header.length).set(header);
	view.setUint32(80, count, true);
	for (let i = 0; i < count; i++)
		for (let k = 0; k < 9; k++) view.setFloat32(84 + i * 50 + 12 + k * 4, soup[i * 9 + k], true);
	return buf;
}
