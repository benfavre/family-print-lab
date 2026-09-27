import { describe, expect, it } from 'vitest';
import { decodePaint, encodePaint, paintTriangle, type PaintNode } from '$lib/shared/slicer/paint';
import { paintSphere } from './paint';
import { paintedFacets, splitFacet, visitPaintFacets, type Facet } from './paint-geometry';

const triangle: Facet = [
	[0, 0, 0],
	[100, 0, 0],
	[0, 100, 0]
];
const soup = Float32Array.from(triangle.flat());
const area = (facet: Facet) =>
	Math.abs(
		(facet[1][0] - facet[0][0]) * (facet[2][1] - facet[0][1]) -
			(facet[1][1] - facet[0][1]) * (facet[2][0] - facet[0][0])
	) / 2;

describe('native painting subdivision geometry', () => {
	it('uses upstream child order for all split sides, preserving area and winding', () => {
		const source: Facet = [
			[0, 0, 0],
			[8, 0, 0],
			[0, 8, 0]
		];
		expect(splitFacet(source, 1, 0)).toEqual([
			[
				[0, 0, 0],
				[8, 0, 0],
				[4, 4, 0]
			],
			[
				[4, 4, 0],
				[0, 8, 0],
				[0, 0, 0]
			]
		]);
		expect(splitFacet(source, 2, 0)).toEqual([
			[
				[0, 0, 0],
				[4, 0, 0],
				[0, 4, 0]
			],
			[
				[4, 0, 0],
				[8, 0, 0],
				[0, 4, 0]
			],
			[
				[8, 0, 0],
				[0, 8, 0],
				[0, 4, 0]
			]
		]);
		for (const split of [1, 2, 3] as const)
			for (const special of split === 3 ? [0] : [0, 1, 2]) {
				const children = splitFacet(source, split, special);
				expect(children).toHaveLength(split + 1);
				expect(children.reduce((sum, child) => sum + area(child), 0)).toBe(32);
				for (const [a, b, c] of children)
					expect((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).toBeGreaterThan(0);
			}
	});

	it('draws an imported native split string in child order and maps every leaf to its source facet', () => {
		// serialize() visits the last child first, then Model.cpp reverses the hexadecimal nibbles.
		const node: PaintNode = {
			split: 3,
			special: 0,
			children: [1, 2, 3, 4].map((state) => ({ state }))
		};
		expect(encodePaint(node)).toBe('480C1C3');
		const mesh = paintedFacets(soup, { 0: '480C1C3' });
		expect([...mesh.states]).toEqual([1, 2, 3, 4]);
		expect([...mesh.sources]).toEqual([0, 0, 0, 0]);
		expect([...mesh.positions]).toEqual(splitFacet(triangle, 3, 0).flat(2));
	});

	it('paints only a small area of a large facet without changing the model mesh', () => {
		const original = soup.slice();
		const paint = paintSphere({}, 'supports', soup, [10, 10, 0], 1, 2)!;
		expect(soup).toEqual(original);
		const tree = decodePaint(paint.supports![0]);
		expect('split' in tree).toBe(true);
		let painted = 0,
			total = 0;
		visitPaintFacets(triangle, tree, (facet, state) => {
			total += area(facet);
			if (state === 2) {
				painted += area(facet);
				for (const v of facet)
					expect(Math.hypot(v[0] - 10, v[1] - 10, v[2])).toBeLessThanOrEqual(1.000001);
			}
		});
		expect(total).toBe(5000);
		expect(painted).toBeGreaterThan(2);
		expect(painted).toBeLessThanOrEqual(Math.PI);
		expect(new Set(paintedFacets(soup, paint.supports).states)).toEqual(new Set([0, 2]));
	});

	it('preserves the rest of an imported subdivision and other painting kinds while repainting and erasing', () => {
		const split: PaintNode = { split: 1, special: 0, children: [{ state: 1 }, { state: 2 }] };
		const part = { paint: { color: { 0: encodePaint(split) }, seam: { 0: paintTriangle(1) } } };
		const painted = paintSphere(part, 'color', soup, [70, 10, 0], 1, 3)!;
		const tree = decodePaint(painted.color![0]);
		expect('split' in tree && tree.children[1]).toEqual({ state: 2 });
		expect(painted.seam).toEqual(part.paint.seam);
		const erased = paintSphere({ paint: painted }, 'color', soup, [70, 10, 0], 2, 0)!;
		const drawn = paintedFacets(soup, erased.color);
		expect(new Set(drawn.states)).toEqual(new Set([0, 1, 2]));
		// A brush enclosing the whole source collapses its tree back to a single leaf.
		expect(paintSphere({ paint: erased }, 'color', soup, [50, 50, 0], 100, 4)?.color).toEqual({
			0: paintTriangle(4)
		});
		expect(paintSphere({ paint: erased }, 'color', soup, [50, 50, 0], 100, 0)).toEqual({
			seam: part.paint.seam
		});
	});

	it('covers both triangles across a shared edge and leaves missed or unreadable facets unchanged', () => {
		const square = Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
		const paint = paintSphere({}, 'fuzzySkin', square, [5, 5, 0], 0.5, 1)!;
		expect(Object.keys(paint.fuzzySkin!)).toEqual(['0', '1']);
		expect(paintSphere({}, 'supports', square, [5, 5, 2], 1, 1)).toBeUndefined();
		const bad = { paint: { supports: { 0: 'zz' } } };
		expect(paintSphere(bad, 'supports', soup, [10, 10, 0], 1, 1)).toEqual(bad.paint);
		expect([...paintedFacets(soup, bad.paint.supports).states]).toEqual([0]);
		expect(
			paintSphere({}, 'supports', Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]), [1, 0, 0], 1, 1)
		).toBeUndefined();
	});
});
