import { describe, expect, it } from 'vitest';
import { primitiveSoup } from '$lib/client/slicer/primitives';
import { applyPoint, boundsOf, compose, recompose } from '$lib/client/slicer/matrix';
import { IDENTITY, type Transform } from '$lib/shared/slicer/project';
import { stats } from '../../cad/mesh';
import { isSolid } from '../../cad/geometry';
import { cutMesh, localCutPlane } from './mesh-tools';

const cube = primitiveSoup('box', [10, 10, 10]);
describe('workspace cuts', () => {
	it.each(['x', 'y', 'z'] as const)(
		'cuts along project %s after rotation, scale, translation and shear',
		async (axis) => {
			const part: Transform = [1, 0.2, 0, 0.3, 1, 0, 0, 0, 1, 7, -2, 1];
			const instance = recompose({
				position: [70, -30, 12],
				rotation: [25, 15, 65],
				scale: [-2, 3, 0.7]
			});
			const transform = compose(part, instance);
			const k = { x: 0, y: 1, z: 2 }[axis];
			const at = applyPoint(transform, [0, 0, 0])[k] + 0.5;
			const pieces = await cutMesh(cube, { transform, axis, at, keep: 'both' });
			expect(pieces.map((p) => p.side)).toEqual(['below', 'above']);
			expect(stats(pieces[0].soup).volume + stats(pieces[1].soup).volume).toBeCloseTo(1000, 3);
			for (const piece of pieces) {
				expect(await isSolid(piece.soup)).toBe(true);
				const b = boundsOf(piece.soup, transform);
				if (piece.side === 'below') expect(b[k + 3]).toBeCloseTo(at, 4);
				else expect(b[k]).toBeCloseTo(at, 4);
			}
		}
	);
	it('keeps a single upper piece in its original coordinates', async () => {
		const [piece] = await cutMesh(cube, { transform: IDENTITY, axis: 'z', at: 2, keep: 'above' });
		expect(piece.side).toBe('above');
		expect(stats(piece.soup).min[2]).toBeCloseTo(2);
		expect(boundsOf(piece.soup, IDENTITY)[5]).toBeCloseTo(5);
		expect(stats(piece.soup).volume).toBeCloseTo(300);
	});
	it('refuses a missed plane, invalid solid or zero scale', async () => {
		await expect(
			cutMesh(cube, { transform: IDENTITY, axis: 'z', at: 50, keep: 'below' })
		).rejects.toThrow('does not cut');
		await expect(
			cutMesh(cube.slice(0, 9), { transform: IDENTITY, axis: 'z', at: 0, keep: 'both' })
		).rejects.toThrow('watertight');
		expect(() =>
			localCutPlane({
				transform: [...IDENTITY.slice(0, 8), 0, 0, 0, 0] as Transform,
				axis: 'x',
				at: 0
			})
		).toThrow('zero scale');
	});
});
