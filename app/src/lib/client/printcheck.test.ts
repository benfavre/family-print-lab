import { describe, expect, it } from 'vitest';
import { fitFactor, meshFacts, printChecks, roughMinutes } from './printcheck';

/** A closed axis-aligned box as a non-indexed triangle list, resting on z = 0. */
function box(x: number, y: number, z: number, skipFaces = 0): Float32Array {
	const v = (i: number) => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0];
	const quads = [
		[0, 2, 3, 1], // bottom
		[4, 5, 7, 6], // top
		[0, 1, 5, 4],
		[2, 6, 7, 3],
		[0, 4, 6, 2],
		[1, 3, 7, 5]
	].slice(skipFaces);
	const out: number[] = [];
	for (const [a, b, c, d] of quads) out.push(...v(a), ...v(b), ...v(c), ...v(a), ...v(c), ...v(d));
	return new Float32Array(out);
}

describe('print checks', () => {
	it('finds a closed box closed, and measures what rests on the plate', () => {
		const facts = meshFacts(box(20, 10, 5));
		expect(facts.openEdges).toBe(0);
		expect(facts.contactArea).toBeCloseTo(200);
	});

	it('counts the open edges of a box missing its bottom', () => {
		const facts = meshFacts(box(20, 10, 5, 1));
		expect(facts.openEdges).toBe(4);
		expect(facts.contactArea).toBe(0);
	});

	it('flags parts that are too big, and says how much to shrink them', () => {
		const checks = printChecks({
			size: [300, 100, 50],
			area: 1000,
			overhangArea: 0,
			openEdges: 0,
			contactArea: 30000
		});
		expect(checks[0]).toMatchObject({ id: 'bed', level: 'fail', fixes: ['fit'] });
		expect(fitFactor([300, 100, 50])).toBeCloseTo((256 / 300) * 0.98);
		expect(fitFactor([100, 100, 50])).toBe(1);
	});

	it('warns about tall parts on a small base and heavy overhangs, worst first', () => {
		const checks = printChecks({
			size: [40, 40, 80],
			area: 10000,
			overhangArea: 3000,
			openEdges: null,
			contactArea: 20
		});
		expect(checks.map((c) => [c.id, c.level])).toEqual([
			['base', 'warn'],
			['supports', 'warn'],
			['bed', 'ok']
		]);
		expect(checks.find((c) => c.id === 'closed')).toBeUndefined();
	});

	it('gives a rough time that grows with material and height', () => {
		expect(roughMinutes(17, 30)).toBeGreaterThan(20);
		expect(roughMinutes(100, 30)).toBeGreaterThan(roughMinutes(17, 30));
	});
});
