import { describe, expect, it } from 'vitest';
import { IDENTITY, type SceneObject } from '$lib/shared/slicer/project';
import {
	adaptiveProfile,
	adjustProfile,
	effectiveProfile,
	heightAt,
	objectLayers,
	objectTriangles,
	profileFromRanges,
	profileProblem,
	slicingParams,
	smoothProfile,
	type SlicingParams
} from './layers';
import { translation } from './matrix';
import { primitiveSoup } from './primitives';

// A 0.4 mm nozzle P1S process as slicer-profiles flattens it (fdm_machine_common / 0.20mm Standard).
const P1S = {
	layer_height: '0.2',
	initial_layer_print_height: '0.2',
	nozzle_diameter: ['0.4'],
	min_layer_height: ['0.08'],
	max_layer_height: ['0.28'],
	raft_layers: '0'
};
const params = (h = 10): SlicingParams => slicingParams(P1S, h);

/** Heights of a profile, and whether its z values never go down. */
const heights = (p: number[]) => p.filter((_, i) => i % 2 === 1);
const rising = (p: number[]) => p.every((v, i) => i % 2 === 1 || i < 2 || v >= p[i - 2] - 1e-9);

describe('slicing parameters', () => {
	it('reads the layer limits as create_from_config does', () => {
		expect(params()).toEqual({
			layerHeight: 0.2,
			firstLayerHeight: 0.2,
			firstLayerFixed: true,
			minLayerHeight: 0.08,
			maxLayerHeight: 0.28,
			objectHeight: 10
		});
		// No limits set: 0.07 mm and three quarters of the nozzle.
		const bare = slicingParams({ layer_height: '0.2', nozzle_diameter: ['0.6'] }, 5);
		expect(bare.minLayerHeight).toBe(0.07);
		expect(bare.maxLayerHeight).toBeCloseTo(0.45);
		// A raft: the first object layer is an ordinary one and not fixed.
		const raft = slicingParams({ ...P1S, raft_layers: '2', initial_layer_print_height: '0.3' }, 5);
		expect(raft).toMatchObject({ firstLayerHeight: 0.2, firstLayerFixed: false });
		// The layer height always fits between the limits.
		expect(slicingParams({ ...P1S, layer_height: '0.32' }, 5).maxLayerHeight).toBe(0.32);
	});
});

describe('layer height profiles', () => {
	it('builds the default profile from the height ranges (layer_height_profile_from_ranges)', () => {
		expect(profileFromRanges(params(), [])).toEqual([0, 0.2, 10, 0.2]);
		expect(
			profileFromRanges(params(), [{ minZ: 2, maxZ: 4, config: { layer_height: '0.1' } }])
		).toEqual([0, 0.2, 2, 0.2, 2, 0.1, 4, 0.1, 4, 0.2, 10, 0.2]);
		// A range without its own layer height, and one past the top (trimmed).
		expect(
			profileFromRanges(params(), [
				{ minZ: 1, maxZ: 3, config: {} },
				{ minZ: 8, maxZ: 12, config: { layer_height: '0.12' } }
			])
		).toEqual([0, 0.2, 8, 0.2, 8, 0.12, 10, 0.12]);
	});

	it('ignores a stored profile the slicer would reject', () => {
		const p = params();
		const good = [0, 0.2, 5, 0.12, 10, 0.2];
		expect(profileProblem(good, p)).toBeNull();
		expect(effectiveProfile(good, [], p)).toBe(good);
		expect(profileProblem([0, 0.2, 8, 0.2], p)).toMatch(/height changed/);
		expect(profileProblem([0, 0.2, 5, 0.05, 10, 0.2], p)).toMatch(/nozzle/);
		expect(profileProblem([0, 0.16, 10, 0.2], p)).toMatch(/first layer/);
		expect(profileProblem([0, 0.2, 10], p)).toMatch(/damaged/);
		expect(effectiveProfile([0, 0.2, 8, 0.2], [], p)).toEqual([0, 0.2, 10, 0.2]);
	});

	it('cuts layers from a profile (generate_object_layers)', () => {
		expect(objectLayers(params(), [0, 0.2, 10, 0.2])).toHaveLength(50);
		const fine = objectLayers(params(), [0, 0.2, 0.2, 0.1, 10, 0.1]);
		expect(fine[0]).toEqual([0, 0.2]);
		expect(fine.length).toBeGreaterThan(95);
		expect(fine.at(-1)![1]).toBeCloseTo(10, 1);
		expect(heightAt([0, 0.2, 10, 0.1], 5)).toBeCloseTo(0.15);
	});

	it('makes layers thicker, thinner, normal again or smoother around a height', () => {
		const p = params();
		const flat = profileFromRanges(p, []);
		let up = flat;
		for (let i = 0; i < 20; i++) up = adjustProfile(p, up, 5, 0.005, 2, 'increase');
		expect(rising(up)).toBe(true);
		expect(up.slice(0, 2)).toEqual([0, 0.2]);
		expect(up[up.length - 2]).toBe(10);
		expect(heightAt(up, 5)).toBeCloseTo(p.maxLayerHeight, 5);
		expect(heightAt(up, 8)).toBeCloseTo(0.2);
		expect(Math.max(...heights(up))).toBeLessThanOrEqual(p.maxLayerHeight + 1e-9);

		let down = flat;
		for (let i = 0; i < 100; i++) down = adjustProfile(p, down, 5, 0.005, 2, 'decrease');
		expect(heightAt(down, 5)).toBeCloseTo(p.minLayerHeight);
		// At the limit, more of the same changes nothing.
		expect(adjustProfile(p, down, 5, 0.005, 2, 'decrease')).toBe(down);

		const back = adjustProfile(p, up, 5, 0.05, 2, 'reduce');
		expect(heightAt(back, 5)).toBeLessThan(heightAt(up, 5));
		expect(heightAt(back, 5)).toBeGreaterThanOrEqual(0.2);

		const smoothed = adjustProfile(p, up, 5.5, 0.05, 4, 'smooth');
		expect(rising(smoothed)).toBe(true);
		// Below the fixed first layer, nothing moves.
		expect(adjustProfile(p, flat, 0.1, 0.005, 2, 'increase')).toBe(flat);
		expect(profileProblem(up, p)).toBeNull();
		expect(profileProblem(down, p)).toBeNull();
	});

	it('smooths a step (smooth_height_profile) and keeps the first layer', () => {
		const p = params();
		const step = [0, 0.2, 0.2, 0.2];
		for (let z = 0.4; z <= 10.001; z += 0.2)
			step.push(Math.round(z * 10) / 10, z < 5 ? 0.08 : 0.28);
		const smooth = smoothProfile(step, p);
		expect(smooth.slice(0, 4)).toEqual([0, 0.2, 0.2, 0.2]);
		const jump = (q: number[]) =>
			Math.max(
				...heights(q)
					.slice(3)
					.map((h, i, a) => Math.abs(h - (a[i - 1] ?? h)))
			);
		expect(jump(smooth)).toBeLessThan(jump(step));
		expect(Math.min(...heights(smooth))).toBeGreaterThanOrEqual(p.minLayerHeight - 1e-9);
	});
});

describe('adaptive layer heights', () => {
	it('keeps thick layers on walls and ends at the top of a box', () => {
		const p = params(10);
		const box = primitiveSoup('box', [20, 20, 10]).map((v, i) => (i % 3 === 2 ? v + 5 : v));
		const profile = adaptiveProfile(p, box, 0.5);
		expect(profile.slice(0, 4)).toEqual([0, 0.2, 0.2, 0.2]);
		expect(rising(profile)).toBe(true);
		expect(profile[profile.length - 2]).toBeCloseTo(10, 6);
		// Vertical walls allow the thickest layer, reached in steps of at most 0.04 mm.
		expect(Math.max(...heights(profile))).toBeCloseTo(0.28);
		const hs = heights(profile);
		for (let i = 1; i < hs.length - 1; i++)
			expect(Math.abs(hs[i] - hs[i - 1])).toBeLessThanOrEqual(0.04 + 1e-9);
	});

	it('thins layers where a sphere’s surface is gentle, and finer quality thins them more', () => {
		const p = params(20);
		const ball = primitiveSoup('sphere', [20, 20, 20], 48).map((v, i) =>
			i % 3 === 2 ? v + 10 : v
		);
		const balanced = adaptiveProfile(p, ball, 0.5);
		const near = (z: number) => heightAt(balanced, z);
		expect(near(19)).toBeLessThan(near(10));
		const fine = adaptiveProfile(p, ball, 0);
		expect(objectLayers(p, fine).length).toBeGreaterThan(objectLayers(p, balanced).length);
		for (const h of heights(fine)) {
			expect(h).toBeGreaterThanOrEqual(p.minLayerHeight - 1e-9);
			expect(h).toBeLessThanOrEqual(p.maxLayerHeight + 1e-9);
		}
	});

	it('takes the model parts under the first instance, standing on 0', () => {
		const soup = primitiveSoup('box', [10, 10, 4]);
		const obj: SceneObject = {
			id: 'o1',
			name: 'Box',
			parts: [
				{ id: 'p1', name: 'Box', type: 'model', mesh: 'm', transform: [...IDENTITY], config: {} },
				{ id: 'p2', name: 'Mod', type: 'modifier', mesh: 'x', transform: [...IDENTITY], config: {} }
			],
			instances: [
				{
					id: 'i1',
					// Twice as tall, somewhere on the bed.
					transform: [1, 0, 0, 0, 1, 0, 0, 0, 2, ...translation(100, 50, 7).slice(9)] as never,
					printable: true
				}
			],
			config: {},
			heightRanges: [],
			printable: true
		};
		const t = objectTriangles(obj, (id) => (id === 'm' ? soup : undefined))!;
		expect(t).toHaveLength(soup.length);
		const zs = t.filter((_, i) => i % 3 === 2);
		expect(Math.min(...zs)).toBe(0);
		expect(Math.max(...zs)).toBeCloseTo(8);
		expect(Math.max(...t.filter((_, i) => i % 3 === 0))).toBeCloseTo(5);
		expect(objectTriangles(obj, () => undefined)).toBeNull();
	});
});
