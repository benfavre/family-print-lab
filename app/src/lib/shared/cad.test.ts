import { describe, expect, it } from 'vitest';
import { textFrame } from './cad';

describe('text placement frame', () => {
	it.each([
		[0, 0.3, -Math.sqrt(0.91)],
		[0.2, -0.3, -Math.sqrt(0.87)],
		[0, 0, -1],
		[0, 0, 1],
		[1, 0, 0]
	])('keeps text in the face plane with unit size for normal %j', (...normal) => {
		const point = [10, -20, 30];
		for (const angle of [0, 37, 90]) {
			const frame = textFrame(point, normal, angle);
			const right = frame.slice(0, 3),
				up = frame.slice(4, 7),
				out = frame.slice(8, 11);
			for (const axis of [right, up, out]) expect(Math.hypot(...axis)).toBeCloseTo(1, 12);
			for (const [a, b] of [
				[right, up],
				[right, out],
				[up, out]
			])
				expect(a.reduce((sum, value, i) => sum + value * b[i], 0)).toBeCloseTo(0, 12);
			const cross = [
				right[1] * up[2] - right[2] * up[1],
				right[2] * up[0] - right[0] * up[2],
				right[0] * up[1] - right[1] * up[0]
			];
			cross.forEach((value, i) => expect(value).toBeCloseTo(normal[i], 12));
			expect(frame.slice(12, 15)).toEqual(point);
		}
	});
	it('preserves the reading direction on a horizontal underside', () => {
		const frame = textFrame([0, 0, 0], [0, 0, -1], 0);
		expect(frame.slice(0, 3)).toEqual([1, 0, 0]);
		expect(frame.slice(4, 7)).toEqual([0, -1, 0]);
	});
});
