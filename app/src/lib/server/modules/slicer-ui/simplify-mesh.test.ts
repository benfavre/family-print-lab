import { describe, expect, it } from 'vitest';
import { primitiveSoup } from '$lib/client/slicer/primitives';
import { isSolid } from '../../cad/geometry';
import { simplifyMesh } from './simplify-mesh';

describe('workspace mesh simplification', () => {
	it('reduces a dense solid using its original translated vertices and remains watertight', async () => {
		const source = primitiveSoup('sphere', [20, 20, 20], 64);
		const offset = [50, -80, 125];
		for (let i = 0; i < source.length; i++) source[i] += offset[i % 3];
		const before = source.slice();
		const result = (await simplifyMesh(source, 0.1))!;
		expect(result.length).toBeLessThan(source.length / 2);
		expect(await isSolid(result)).toBe(true);
		expect(source).toEqual(before);
		const vertices = new Set<string>();
		for (let i = 0; i < source.length; i += 3) vertices.add([...source.slice(i, i + 3)].join(','));
		for (let i = 0; i < result.length; i += 3)
			expect(vertices.has([...result.slice(i, i + 3)].join(','))).toBe(true);
	});
	it('reports no reduction for an already simple cube rather than replacing its mesh', async () => {
		expect(await simplifyMesh(primitiveSoup('box', [20, 20, 20]), 0.001)).toBeNull();
	});
	it('refuses open meshes and invalid tolerances', async () => {
		const cube = primitiveSoup('box', [20, 20, 20]);
		await expect(simplifyMesh(cube.slice(0, 9), 0.1)).rejects.toThrow('watertight');
		for (const value of [0, -1, NaN, Infinity, 10001])
			await expect(simplifyMesh(cube, value)).rejects.toThrow('tolerance');
	});
});
