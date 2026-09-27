import { describe, expect, it } from 'vitest';
import { primitiveSoup } from '$lib/client/slicer/primitives';
import { compose, recompose, translation, boundsOf, unionBox } from '$lib/client/slicer/matrix';
import { IDENTITY, type Transform } from '$lib/shared/slicer/project';
import { stats } from '../../cad/mesh';
import { isSolid } from '../../cad/geometry';
import { booleanMesh } from './boolean';
const cube = primitiveSoup('box', [10, 10, 10]);
describe('workspace boolean geometry', () => {
	it.each([
		['union', 1500],
		['subtract', 500],
		['intersect', 500]
	] as const)(
		'%s keeps the first coordinate system under rotation, shear and mirrored scale',
		async (mode, volume) => {
			const shear: Transform = [1, 0.2, 0, 0.3, 1, 0, 0, 0, 1, 7, 1, -3];
			const first = compose(
				shear,
				recompose({ position: [70, -30, 12], rotation: [25, 15, 65], scale: [-2, 3, 0.7] })
			);
			const reflected = recompose({ position: [5, 0, 0], rotation: [0, 0, 0], scale: [-1, 1, 1] });
			const second = compose(reflected, first);
			const soup = await booleanMesh(cube, cube, first, second, mode);
			expect(await isSolid(soup)).toBe(true);
			expect(stats(soup).volume).toBeCloseTo(volume, 3);
			if (mode === 'union') {
				const expected = unionBox([boundsOf(cube, first), boundsOf(cube, second)]);
				boundsOf(soup, first).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 4));
			}
		}
	);
	it('refuses empty results and invalid transforms or open meshes', async () => {
		await expect(
			booleanMesh(cube, cube, IDENTITY, translation(100, 0, 0), 'intersect')
		).rejects.toThrow('leaves nothing');
		await expect(booleanMesh(cube, cube, IDENTITY, IDENTITY, 'subtract')).rejects.toThrow(
			'leaves nothing'
		);
		await expect(
			booleanMesh(cube, cube, IDENTITY, [0, ...IDENTITY.slice(1)] as Transform, 'union')
		).rejects.toThrow('zero scale');
		await expect(booleanMesh(cube, cube.slice(0, 9), IDENTITY, IDENTITY, 'union')).rejects.toThrow(
			'watertight'
		);
	});
});
