import { describe, expect, it } from 'vitest';
import { addMeasurePoint, measure } from './measure';
import { applyPoint, compose, recompose, translation } from './matrix';

describe('project measurements', () => {
	it('measures transformed world coordinates, including anisotropic scale and rotation', () => {
		const transform = compose(
			recompose({ position: [5, 0, 0], rotation: [0, 0, 90], scale: [2, 3, 4] }),
			translation(100, -30, 2)
		);
		const a = applyPoint(transform, [0, 0, 0]);
		const b = applyPoint(transform, [3, 4, 3]);
		const result = measure([a, b])!;
		expect(result.distance).toBeCloseTo(18);
		expect(result.delta[0]).toBeCloseTo(-12);
		expect(result.delta[1]).toBeCloseTo(6);
		expect(result.delta[2]).toBeCloseTo(12);
	});
	it('keeps coincident points valid, waits for two points and restarts on a third', () => {
		const first = addMeasurePoint([], [1, 2, 3]);
		expect(measure(first)).toBeNull();
		const both = addMeasurePoint(first, [1, 2, 3]);
		expect(measure(both)).toEqual({ distance: 0, delta: [0, 0, 0] });
		expect(addMeasurePoint(both, [4, 5, 6])).toEqual([[4, 5, 6]]);
		expect(first).toEqual([[1, 2, 3]]);
	});
	it('ignores invalid clicks and never reports a nonfinite measurement', () => {
		expect(addMeasurePoint([], [NaN, 0, 0])).toEqual([]);
		expect(
			measure([
				[0, 0, 0],
				[Infinity, 1, 2]
			])
		).toBeNull();
	});
});
