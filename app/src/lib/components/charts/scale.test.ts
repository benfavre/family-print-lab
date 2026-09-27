import { describe, expect, it } from 'vitest';
import { arc, linear, linePath, niceCeil, slices, stack, thin, ticks, toneColor } from './scale';

describe('chart scales', () => {
	it('rounds up to nice numbers', () => {
		expect([0, -1, NaN, 0.3, 1, 1.2, 2.2, 3, 7, 10, 12, 2400].map(niceCeil)).toEqual([
			1, 1, 1, 0.5, 1, 2, 2.5, 5, 10, 10, 20, 2500
		]);
	});

	it('makes ticks from zero to a nice top that covers the maximum', () => {
		expect(ticks(100)).toEqual([0, 25, 50, 75, 100]);
		expect(ticks(130)).toEqual([0, 50, 100, 150]);
		expect(ticks(0)).toEqual([0, 0.25, 0.5, 0.75, 1]);
		expect(ticks(1, 2)).toEqual([0, 0.5, 1]);
		expect(ticks(0.3)).toEqual([0, 0.1, 0.2, 0.3]);
	});

	it('maps linearly, flipping for SVG y', () => {
		const y = linear([0, 100], [90, 0]);
		expect(y(0)).toBe(90);
		expect(y(50)).toBe(45);
		expect(y(100)).toBe(0);
		expect(linear([5, 5], [0, 10])(5)).toBe(0);
	});

	it('breaks lines where values are missing', () => {
		expect(linePath([{ x: 0, y: 1 }, { x: 1, y: 2 }, null, { x: 3, y: 0.333333 }])).toBe(
			'M0,1L1,2M3,0.33'
		);
		expect(linePath([])).toBe('');
	});

	it('splits a donut by share, skipping empty slices', () => {
		const s = slices([{ value: 1 }, { value: 0 }, { value: 3 }]);
		expect(s.map((x) => x.share)).toEqual([0.25, 0.75]);
		expect(s[0].a0).toBe(0);
		expect(s[1].a1).toBeCloseTo(Math.PI * 2);
		expect(slices([{ value: 0 }])).toEqual([]);
	});

	it('draws arcs, a full ring as two halves', () => {
		expect(arc(50, 50, 40, 20, 0, Math.PI / 2)).toBe(
			'M50,10 A40,40 0 0 1 90,50 L70,50 A20,20 0 0 0 50,30 Z'
		);
		expect(arc(50, 50, 40, 20, 0, Math.PI * 2).match(/M/g)).toHaveLength(2);
	});

	it('stacks columns', () => {
		expect(
			stack([
				[1, 2],
				[0, 4]
			])
		).toEqual([
			[
				{ y0: 0, y1: 1 },
				{ y0: 1, y1: 3 }
			],
			[
				{ y0: 0, y1: 0 },
				{ y0: 0, y1: 4 }
			]
		]);
	});

	it('thins crowded labels, keeping the last', () => {
		expect(thin(['a', 'b', 'c', 'd', 'e'], 3)).toEqual(['a', null, 'c', null, 'e']);
		expect(thin(['a', 'b'], 10)).toEqual(['a', 'b']);
	});

	it('names theme colours', () => {
		expect(toneColor('cyan')).toBe('var(--cyan)');
		expect(toneColor('dim')).toBe('var(--dim)');
	});
});
