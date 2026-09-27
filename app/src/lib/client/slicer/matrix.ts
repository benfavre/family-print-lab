// Transform maths for the slicer workspace, on the project's own 3MF transforms (shared/slicer/project.ts:
// row-major 3×4, points as row vectors, p' = p·M, translation in the last row). A part's vertices reach
// the bed through its volume matrix, then its instance's: world = compose(part.transform,
// instance.transform), as Bambu Studio builds them (ModelVolume, ModelInstance) and cli.ts bakes them.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import {
	IDENTITY,
	matrix4ToTransform,
	transformToMatrix4,
	type Transform
} from '$lib/shared/slicer/project';

export type Vec3 = [number, number, number];
export type Box = [number, number, number, number, number, number];

export const toMatrix4 = (t: Transform) => new Matrix4().fromArray(transformToMatrix4(t));
export const fromMatrix4 = (m: Matrix4) => clean(matrix4ToTransform(m.elements));

/** Rounds away float noise (1e-12) so saved files stay tidy. */
function clean(t: Transform): Transform {
	return t.map((v) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v) + 0) as Transform;
}

/** a then b (row vectors: p·a·b). */
export function compose(a: Transform, b: Transform): Transform {
	return fromMatrix4(toMatrix4(b).multiply(toMatrix4(a)));
}

export function invert(t: Transform): Transform {
	return fromMatrix4(toMatrix4(t).invert());
}

export const translation = (x: number, y: number, z = 0): Transform => [
	1,
	0,
	0,
	0,
	1,
	0,
	0,
	0,
	1,
	x,
	y,
	z
];

/** A transform moved by (dx, dy, dz) in bed coordinates. */
export function translate(t: Transform, dx: number, dy: number, dz = 0): Transform {
	const out = [...t] as Transform;
	out[9] += dx;
	out[10] += dy;
	out[11] += dz;
	return out;
}

export function applyPoint(t: Transform, p: Vec3): Vec3 {
	const [x, y, z] = p;
	return [
		x * t[0] + y * t[3] + z * t[6] + t[9],
		x * t[1] + y * t[4] + z * t[7] + t[10],
		x * t[2] + y * t[5] + z * t[8] + t[11]
	];
}

/** Position, rotation (degrees, XYZ Euler like Bambu Studio's object panel) and scale of a transform. */
export interface Parts {
	position: Vec3;
	rotation: Vec3;
	scale: Vec3;
}

const DEG = 180 / Math.PI;

export function decompose(t: Transform): Parts {
	const p = new Vector3(),
		q = new Quaternion(),
		s = new Vector3();
	toMatrix4(t).decompose(p, q, s);
	const e = new Euler().setFromQuaternion(q, 'XYZ');
	const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
	return {
		position: [r(p.x), r(p.y), r(p.z)],
		rotation: [r(e.x * DEG), r(e.y * DEG), r(e.z * DEG)],
		scale: [r(s.x), r(s.y), r(s.z)]
	};
}

export function recompose(parts: Parts): Transform {
	const q = new Quaternion().setFromEuler(
		new Euler(parts.rotation[0] / DEG, parts.rotation[1] / DEG, parts.rotation[2] / DEG, 'XYZ')
	);
	return fromMatrix4(
		new Matrix4().compose(new Vector3(...parts.position), q, new Vector3(...parts.scale))
	);
}

/** Bounds of a triangle soup (x y z per vertex) under a transform. */
export function boundsOf(positions: Float32Array, t: Transform = IDENTITY): Box {
	const b: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (let i = 0; i < positions.length; i += 3) {
		const x = positions[i],
			y = positions[i + 1],
			z = positions[i + 2];
		const wx = x * t[0] + y * t[3] + z * t[6] + t[9];
		const wy = x * t[1] + y * t[4] + z * t[7] + t[10];
		const wz = x * t[2] + y * t[5] + z * t[8] + t[11];
		if (wx < b[0]) b[0] = wx;
		if (wy < b[1]) b[1] = wy;
		if (wz < b[2]) b[2] = wz;
		if (wx > b[3]) b[3] = wx;
		if (wy > b[4]) b[4] = wy;
		if (wz > b[5]) b[5] = wz;
	}
	return positions.length ? b : [0, 0, 0, 0, 0, 0];
}

/** The union of boxes (an empty list gives a zero box). */
export function unionBox(boxes: Box[]): Box {
	if (!boxes.length) return [0, 0, 0, 0, 0, 0];
	return [
		Math.min(...boxes.map((b) => b[0])),
		Math.min(...boxes.map((b) => b[1])),
		Math.min(...boxes.map((b) => b[2])),
		Math.max(...boxes.map((b) => b[3])),
		Math.max(...boxes.map((b) => b[4])),
		Math.max(...boxes.map((b) => b[5]))
	];
}

/** The instance transform moved up or down so the lowest point `minZ` (world) rests on the bed. */
export function dropToBed(instance: Transform, minZ: number): Transform {
	return translate(instance, 0, 0, -minZ);
}

/** Turns an instance about the vertical axis through `pivot` (world), by degrees. */
export function rotateAbout(
	instance: Transform,
	axis: Vec3,
	degrees: number,
	pivot: Vec3
): Transform {
	const turn = new Matrix4().makeRotationAxis(new Vector3(...axis).normalize(), degrees / DEG);
	const m = new Matrix4()
		.makeTranslation(pivot[0], pivot[1], pivot[2])
		.multiply(turn)
		.multiply(new Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]))
		.multiply(toMatrix4(instance));
	return fromMatrix4(m);
}

/**
 * "Lay on face": the instance turned so a face with world normal `normal` points straight down, about
 * `pivot` (Bambu Studio's GLGizmoFlatten rotates the object the same way). The caller drops it to
 * the bed afterwards.
 */
export function layOnFace(instance: Transform, normal: Vec3, pivot: Vec3): Transform {
	const n = new Vector3(...normal).normalize();
	const q = new Quaternion().setFromUnitVectors(n, new Vector3(0, 0, -1));
	const m = new Matrix4()
		.makeTranslation(pivot[0], pivot[1], pivot[2])
		.multiply(new Matrix4().makeRotationFromQuaternion(q))
		.multiply(new Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]))
		.multiply(toMatrix4(instance));
	return fromMatrix4(m);
}

/** A face normal (unit) of triangle `tri` of a soup, in world coordinates under `t`. */
export function faceNormal(positions: Float32Array, tri: number, t: Transform): Vec3 {
	const v = (k: number) =>
		new Vector3(
			...applyPoint(t, [
				positions[tri * 9 + k * 3],
				positions[tri * 9 + k * 3 + 1],
				positions[tri * 9 + k * 3 + 2]
			])
		);
	const a = v(0),
		b = v(1),
		c = v(2);
	const n = b.sub(a).cross(c.sub(a)).normalize();
	return [n.x, n.y, n.z];
}

/** Snaps a value to a step (0: no snapping). */
export function snap(value: number, step: number): number {
	if (!step) return value;
	return Math.round(Math.round(value / step) * step * 1e6) / 1e6;
}
