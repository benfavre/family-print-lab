// 3MF transforms: 12 numbers, a row-major 3×4 matrix for row vectors (p' = p·M, translation last),
// 3MF core specification 3.3. Parsing, formatting and composition.
import type { Transform } from '$lib/shared/slicer/project';
import { formatNumber } from './mesh';

/** Parses a transform attribute; null when it is not 12 finite numbers. */
export function parseTransform(s: string): Transform | null {
	const n = s.trim().split(/\s+/).map(Number);
	return n.length === 12 && n.every(Number.isFinite) ? (n as Transform) : null;
}

export const formatTransform = (t: Transform) => t.map(formatNumber).join(' ');

/** The transform that applies `a` then `b` (p·A·B). */
export function composeTransforms(a: Transform, b: Transform): Transform {
	const out = new Array<number>(12);
	for (let r = 0; r < 4; r++)
		for (let c = 0; c < 3; c++) {
			let v = r === 3 ? b[9 + c] : 0;
			for (let k = 0; k < 3; k++) v += a[r * 3 + k] * b[k * 3 + c];
			out[r * 3 + c] = v;
		}
	return out as Transform;
}

export const isIdentity = (t: Transform) =>
	t.every((v, i) => v === (i === 0 || i === 4 || i === 8 ? 1 : 0));
