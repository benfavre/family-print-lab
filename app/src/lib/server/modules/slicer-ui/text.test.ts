import { describe, expect, it } from 'vitest';
import { Matrix3, Vector3 } from 'three';
import { primitiveSoup } from '$lib/client/slicer/primitives';
import { applyPoint, compose, recompose, toMatrix4 } from '$lib/client/slicer/matrix';
import type { Transform } from '$lib/shared/slicer/project';
import { IDENTITY } from '$lib/shared/slicer/project';
import { stats } from '../../cad/mesh';
import { isSolid } from '../../cad/geometry';
import { textMesh } from './text';

const cube = primitiveSoup('box', [40, 40, 40]);
describe('workspace text geometry', () => {
	it.each(['emboss', 'engrave'] as const)(
		'%s uses millimetres on the transformed surface without moving the mesh',
		async (mode) => {
			const shear: Transform = [1, 0.2, 0, 0.3, 1, 0, 0, 0, 1, 2, -1, 3];
			const transform = compose(
				shear,
				recompose({ position: [70, -30, 12], rotation: [25, 15, 65], scale: [-2, 3, 0.7] })
			);
			const normal = new Vector3(0, 0, 1)
				.applyNormalMatrix(new Matrix3().getNormalMatrix(toMatrix4(transform)))
				.toArray() as [number, number, number];
			const point = applyPoint(transform, [0, 0, 20]);
			const result = await textMesh(cube, {
				transform,
				text: 'I',
				font: 'bold',
				size: 8,
				depth: 1,
				mode,
				point,
				normal,
				angle: 17
			});
			expect(await isSolid(result)).toBe(true);
			if (mode === 'emboss') expect(stats(result).volume).toBeGreaterThan(stats(cube).volume);
			else expect(stats(result).volume).toBeLessThan(stats(cube).volume);
			let highest = -Infinity;
			for (let i = 0; i < result.length; i += 3) {
				const p = applyPoint(transform, [result[i], result[i + 1], result[i + 2]]);
				highest = Math.max(
					highest,
					p.reduce((sum, n, k) => sum + (n - point[k]) * normal[k], 0)
				);
			}
			expect(highest).toBeCloseTo(mode === 'emboss' ? 1 : 0, 4);
		},
		60_000
	);
	it.each(['emboss', 'engrave'] as const)(
		'refuses %s text away from the object',
		async (mode) => {
			await expect(
				textMesh(cube, {
					transform: IDENTITY,
					text: 'I',
					font: 'bold',
					size: 8,
					depth: 1,
					mode,
					point: [1000, 0, 20],
					normal: [0, 0, 1],
					angle: 0
				})
			).rejects.toThrow('touch the object');
		},
		60_000
	);
});
