import { describe, expect, it } from 'vitest';
import {
	PaintCodecError,
	decodePaint,
	encodePaint,
	paintStates,
	paintTriangle,
	replacePaintState,
	type PaintNode
} from './paint';

describe('painting strings (TriangleSelector serialisation)', () => {
	it('decodes whole-triangle states', () => {
		expect(decodePaint('4')).toEqual({ state: 1 });
		expect(decodePaint('8')).toEqual({ state: 2 });
		// State 3 and up: 0b1100, then the rest (last nibble first in the string).
		expect(decodePaint('0C')).toEqual({ state: 3 });
		expect(decodePaint('1C')).toEqual({ state: 4 });
		expect(() => decodePaint('FC')).toThrow(PaintCodecError);
		expect(decodePaint('0FC')).toEqual({ state: 18 });
		expect(decodePaint('1FC')).toEqual({ state: 19 });
	});

	it('decodes split triangles with children in upstream order', () => {
		// Split in two (1 split side, special side 0); children are written last child first.
		expect(decodePaint('481')).toEqual({
			split: 1,
			special: 0,
			children: [{ state: 1 }, { state: 2 }]
		});
	});

	it('encodes what upstream writes', () => {
		expect(paintTriangle(0)).toBe('');
		expect(paintTriangle(1)).toBe('4');
		expect(paintTriangle(2)).toBe('8');
		expect(paintTriangle(3)).toBe('0C');
		expect(paintTriangle(18)).toBe('0FC');
		expect(encodePaint({ split: 1, special: 0, children: [{ state: 1 }, { state: 2 }] })).toBe(
			'481'
		);
	});

	it('round-trips deep trees', () => {
		let seed = 7;
		const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n) as number;
		const tree = (depth: number): PaintNode => {
			if (depth > 4 || rnd(3) === 0) return { state: rnd(40) };
			const split = (1 + rnd(3)) as 1 | 2 | 3;
			return {
				split,
				special: rnd(4) as 0 | 1 | 2 | 3,
				children: Array.from({ length: split + 1 }, () => tree(depth + 1))
			};
		};
		for (let i = 0; i < 200; i++) {
			const t = tree(0);
			const s = encodePaint(t);
			expect(s).toMatch(/^[0-9A-F]+$/);
			expect(decodePaint(s)).toEqual(t);
			expect(encodePaint(decodePaint(s))).toBe(s);
		}
	});

	it('accepts lower-case hex and rejects broken strings', () => {
		expect(decodePaint('0c')).toEqual({ state: 3 });
		expect(() => decodePaint('')).toThrow(PaintCodecError);
		expect(() => decodePaint('xyz')).toThrow(PaintCodecError);
		expect(() => decodePaint('1')).toThrow('ends early');
		expect(() => decodePaint('44')).toThrow('trailing');
		expect(() => encodePaint({ split: 2, special: 0, children: [{ state: 1 }] })).toThrow(
			PaintCodecError
		);
	});

	it('lists and replaces states', () => {
		const t = decodePaint('481');
		expect([...paintStates(t)].sort()).toEqual([1, 2]);
		expect(replacePaintState(t, 2, 1)).toEqual({ state: 1 });
		expect(replacePaintState(t, 2, 3)).toEqual({
			split: 1,
			special: 0,
			children: [{ state: 1 }, { state: 3 }]
		});
	});
});
