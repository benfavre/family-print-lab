// The G-code parser against real Bambu Studio output (__fixtures__/README.md says where each file comes
// from) and small hand-written programs for the rules one at a time.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readZip } from '../cad/mesh';
import { createGcodeParser, packPreview, type ParseOptions } from './parse';
import {
	PREVIEW_FEATURES,
	TRAVEL_FEATURE,
	decodePreview,
	encodePreview,
	type PreviewData
} from '$lib/shared/slicer/preview';

const fixture = (name: string) => {
	const zip = readZip(fs.readFileSync(path.join(__dirname, '__fixtures__', name)), (n) =>
		n === 'Metadata/plate_1.gcode' ? 'all' : false
	);
	return zip.get('Metadata/plate_1.gcode')!;
};

function parse(gcode: string | Uint8Array, o: Partial<ParseOptions> = {}, chunk = 0): PreviewData {
	const p = createGcodeParser({ plate: 1, features: PREVIEW_FEATURES, ...o });
	const bytes = typeof gcode === 'string' ? new TextEncoder().encode(gcode) : gcode;
	if (!chunk) p.push(bytes);
	else for (let i = 0; i < bytes.length; i += chunk) p.push(bytes.subarray(i, i + chunk));
	return p.finish();
}

const F = (name: (typeof PREVIEW_FEATURES)[number]) => PREVIEW_FEATURES.indexOf(name);
const features = (d: PreviewData) => {
	const seen = new Set<string>();
	for (let i = 0; i < d.header.segments; i++) seen.add(PREVIEW_FEATURES[d.attr[i * 4]]);
	return seen;
};
const point = (d: PreviewData, i: number) => [...d.seg.subarray(i * 6, i * 6 + 6)];

describe('real Bambu Studio G-code', () => {
	it('an A1 two-colour cube: layers, both filaments, the prime tower and the slicer total', () => {
		const d = parse(fixture('a1-two-colour-cube.gcode.3mf'), {
			filaments: [
				{ index: 0, color: '#00AE42', type: 'PLA' },
				{ index: 1, color: '#FFFF00', type: 'PLA' }
			]
		});
		// The upstream test file keeps 9 of its 128 layers (README).
		expect(d.header.layers.map((l) => l.z)).toEqual([
			0.2, 0.4, 0.6, 24.6, 24.8, 25, 25.2, 25.4, 25.6
		]);
		expect(d.header.layers.every((l) => l.height === 0.2)).toBe(true);
		expect(d.header.tools).toEqual([
			{ index: 0, color: '#00AE42', type: 'PLA' },
			{ index: 1, color: '#FFFF00', type: 'PLA' }
		]);
		// 4h 12m 53s from the header.
		expect(d.header.totalSeconds).toBe(15173);
		for (const f of ['Outer wall', 'Inner wall', 'Prime tower', 'Bridge', 'Top surface', 'Wipe'])
			expect(features(d)).toContain(f);
		// Both filaments print walls.
		const wallTools = new Set<number>();
		for (let i = 0; i < d.header.segments; i++)
			if (d.attr[i * 4] === F('Outer wall')) wallTools.add(d.attr[i * 4 + 1]);
		expect([...wallTools].sort()).toEqual([0, 1]);
		// Layers tile the segments in order.
		let next = 0;
		for (const l of d.header.layers) {
			expect(l.first).toBe(next);
			next += l.count;
		}
		expect(next).toBe(d.header.segments);
		// The bed is 256 mm; extrusions stay on it (the purge line runs at y = -0.5).
		expect(d.header.bbox[0]).toBeGreaterThanOrEqual(0);
		expect(d.header.bbox[4]).toBeLessThanOrEqual(256);
		expect(d.header.bbox[5]).toBe(25.6);
	});

	it('an X1 Carbon plate from the pinned Bambu Studio: 29 layers on the third filament', () => {
		const gcode = fixture('x1c-petg-light-guide.gcode.3mf');
		const d = parse(gcode);
		expect(d.header.layers).toHaveLength(29); // "; total layer number: 29"
		expect(d.header.layers.every((l) => l.height === 0.1)).toBe(true);
		// From the G-code's config block: filament 3 is a clear PETG.
		expect(d.header.tools).toEqual([{ index: 2, color: '#D8EDF0', type: 'PETG' }]);
		expect(features(d)).toEqual(
			new Set([
				'Travel',
				'Custom',
				'Outer wall',
				'Bottom surface',
				'Wipe',
				'Gap infill',
				'Internal solid infill',
				'Sparse infill'
			])
		);
		// Layer times add up to about the "model printing time" (4m 48s; the rest is preparation).
		const sum = d.header.layers.reduce((a, l) => a + l.seconds!, 0);
		expect(sum).toBeGreaterThan(288 * 0.75);
		expect(sum).toBeLessThan(288 * 1.25);
		// Extrusions carry the line width and layer height (0.01 mm units).
		const outer = [...Array(d.header.segments).keys()].find(
			(i) => d.attr[i * 4] === F('Outer wall')
		)!;
		expect(d.attr[outer * 4 + 3]).toBe(10);
		expect(d.attr[outer * 4 + 2]).toBeGreaterThan(30);
	});

	it('an A1 mini cube: 50 layers, arcs and floating vertical shells, times near the slicer’s', () => {
		const d = parse(fixture('a1-mini-cube.gcode.3mf'));
		expect(d.header.layers).toHaveLength(50);
		expect(features(d)).toContain('Floating vertical shell');
		const sum = d.header.layers.reduce((a, l) => a + l.seconds!, 0);
		expect(Math.abs(sum - 371) / 371).toBeLessThan(0.1); // model printing time 6m 11s
		expect(d.header.totalSeconds).toBe(792); // 13m 12s
	});

	it('gives the same result however the text is cut into chunks', () => {
		const gcode = fixture('a1-two-colour-cube.gcode.3mf');
		const whole = parse(gcode);
		const bits = parse(gcode, {}, 777);
		expect(bits.header).toEqual(whole.header);
		expect(bits.seg).toEqual(whole.seg);
		expect(bits.attr).toEqual(whole.attr);
		expect(bits.speed).toEqual(whole.speed);
	});
});

describe('moves', () => {
	it('G0 and G1 extrude when E grows while moving in X/Y, otherwise travel', () => {
		const d = parse(
			[
				'G90',
				'M83',
				'G1 X10 Y0 F6000', // travel
				'G1 X20 E1', // extrude
				'G0 X30 E0.5', // G0 extrudes too
				'G1 X40 E-0.8', // retract while moving: travel
				'G1 E0.8', // unretract: no segment
				'G1 Z1 E0.1', // Z only with E: travel
				''
			].join('\n')
		);
		expect([...Array(d.header.segments).keys()].map((i) => d.attr[i * 4])).toEqual([
			TRAVEL_FEATURE,
			F('Custom'),
			F('Custom'),
			TRAVEL_FEATURE,
			TRAVEL_FEATURE
		]);
		expect(d.speed[0]).toBe(100); // F6000 mm/min
	});

	it('follows G90/G91, M82/M83 and G92', () => {
		const d = parse(
			[
				'G90',
				'M82',
				'G92 E0',
				'G1 X10 Y10 E1', // absolute E: +1, extrude
				'G1 X20 E1', // same E: travel
				'G91',
				'G1 X5 Y5 E1', // relative everything: extrude to 25,15
				'G90',
				'G92 X0', // this point is now x = 0
				'G1 X10 E3', // machine x 35
				''
			].join('\n')
		);
		expect(point(d, 0)).toEqual([0, 0, 0, 10, 10, 0]);
		expect(d.attr[4]).toBe(TRAVEL_FEATURE);
		expect(point(d, 2)).toEqual([20, 10, 0, 25, 15, 0]);
		expect(d.attr[8]).toBe(F('Custom'));
		expect(point(d, 3)).toEqual([25, 15, 0, 35, 15, 0]);
		expect(d.attr[12]).toBe(F('Custom'));
	});

	it('cuts arcs into pieces within 0.0125 mm, clockwise and anticlockwise', () => {
		// A quarter circle of radius 10 around (10, 0), from (0, 0) to (10, 10).
		const cw = parse('G90\nM83\nG1 X0 Y0\nG2 X10 Y10 I10 J0 E1\n');
		const ccw = parse('G90\nM83\nG1 X0 Y0\nG3 X10 Y10 I10 J0 E1\n');
		const step = 2 * Math.acos((10 - 0.0125) / 10);
		expect(cw.header.segments).toBe(Math.ceil(Math.PI / 2 / step));
		expect(ccw.header.segments).toBe(Math.ceil((3 * Math.PI) / 2 / step));
		for (const d of [cw, ccw]) {
			for (let i = 0; i < d.header.segments; i++) {
				const [x0, y0, , x1, y1] = point(d, i);
				expect(Math.hypot(x0 - 10, y0)).toBeCloseTo(10, 3);
				expect(Math.hypot(x1 - 10, y1)).toBeCloseTo(10, 3);
			}
			const last = point(d, d.header.segments - 1);
			expect(last.slice(3)).toEqual([10, 10, 0]);
		}
		// Clockwise from (0, 0) around (10, 0) goes up through (10 - 10cos, +y).
		expect(point(cw, 1)[4]).toBeGreaterThan(0);
		expect(point(ccw, 1)[4]).toBeLessThan(0);
	});

	it('a P1 arc back to its start is a full (spiral) circle; arcs without E travel', () => {
		const d = parse('G90\nG1 X10 Y10 Z1\nG17\nG2 Z1.4 I0.86 J0.86 P1 F10000\n');
		const arc = [...Array(d.header.segments).keys()].slice(1);
		expect(arc.length).toBeGreaterThan(4);
		const end = point(d, d.header.segments - 1);
		expect(end[3]).toBeCloseTo(10, 5);
		expect(end[4]).toBeCloseTo(10, 5);
		expect(end[5]).toBeCloseTo(1.4, 5);
		expect(arc.every((i) => d.attr[i * 4] === TRAVEL_FEATURE)).toBe(true);
	});

	it('G28 homes to 0 on the named axes, or all three, as a travel', () => {
		const d = parse('G90\nG1 X50 Y60 Z5\nG28 X\nG1 Y70\nG28\n');
		expect(point(d, 1)).toEqual([50, 60, 5, 0, 60, 5]);
		expect(point(d, 2)).toEqual([0, 60, 5, 0, 70, 5]);
		expect(point(d, 3)).toEqual([0, 70, 5, 0, 0, 0]);
		expect([1, 2, 3].every((i) => d.attr[i * 4] === TRAVEL_FEATURE)).toBe(true);
	});

	it('relative arcs (G91) as in Bambu’s nozzle wipe', () => {
		const d = parse('G90\nG1 X128 Y261\nG91\nG2 I1 J0 X2 Y0 F2000\nG2 I-0.75 J0 X-1.5\n');
		const end = point(d, d.header.segments - 1);
		expect(end[3]).toBeCloseTo(128.5, 5);
		expect(end[4]).toBeCloseTo(261, 5);
	});
});

describe('comments and commands', () => {
	it('maps Bambu roles, other slicers’ names, wipes and flushes to feature codes', () => {
		const d = parse(
			[
				'M83',
				'; FEATURE: Outer wall',
				'G1 X1 E1',
				';TYPE:External perimeter',
				'G1 X2 E1',
				'; FEATURE: Something new',
				'G1 X3 E1',
				'; FEATURE: Support ironing',
				'G1 X4 E1',
				'; WIPE_START',
				'G1 X5 E-0.2',
				'; WIPE_END',
				'; FLUSH_START',
				'G1 X6 E5',
				'; FLUSH_END',
				'G1 X7 E1',
				''
			].join('\n')
		);
		expect(
			[...Array(d.header.segments).keys()].map((i) => PREVIEW_FEATURES[d.attr[i * 4]])
		).toEqual([
			'Outer wall',
			'Outer wall',
			'Other',
			'Support ironing',
			'Wipe',
			'Flush',
			'Support ironing'
		]);
	});

	it('splits layers at CHANGE_LAYER and keeps the start G-code in the first', () => {
		const d = parse(
			[
				'M83',
				'G1 X5 E1', // purge line, before the first layer
				'; CHANGE_LAYER',
				'; Z_HEIGHT: 0.2',
				'; LAYER_HEIGHT: 0.2',
				'G1 Z0.2',
				'G1 X10 E1',
				'; CHANGE_LAYER',
				'; Z_HEIGHT: 0.4',
				'; LAYER_HEIGHT: 0.2',
				'; LINE_WIDTH: 0.45',
				'G1 Z0.4',
				'G1 X20 E1',
				'G1 X30 E1',
				''
			].join('\n')
		);
		expect(
			d.header.layers.map(({ z, height, first, count }) => ({ z, height, first, count }))
		).toEqual([
			{ z: 0.2, height: 0.2, first: 0, count: 3 },
			{ z: 0.4, height: 0.2, first: 3, count: 3 }
		]);
		expect(d.attr[4 * 4 + 2]).toBe(45);
		expect(d.attr[4 * 4 + 3]).toBe(20);
	});

	it('reads PrusaSlicer-style layer comments, and finds layers by height when there are none', () => {
		const prusa = parse(';LAYER_CHANGE\n;Z:0.3\n;HEIGHT:0.3\nM83\nG1 Z0.3\nG1 X1 E1\n');
		expect(prusa.header.layers).toMatchObject([{ z: 0.3, height: 0.3 }]);
		const bare = parse('M83\nG1 Z0.2\nG1 X1 E1\nG1 X2 E1\nG1 Z0.4\nG1 X1 E1\n');
		expect(bare.header.layers.map((l) => [l.z, l.first, l.count, l.seconds])).toEqual([
			[0.2, 0, 3, null],
			[0.4, 3, 2, null]
		]);
	});

	it('changes filament on T0–T254 and M1020, not on Bambu’s special T255/T1000', () => {
		const d = parse(
			'M83\nT1\nG1 X1 E1\nT255\nT1000\nG1 X2 E1\n    T2\nG1 X3 E1\nM1020 S3\nG1 X4 E1\n'
		);
		expect([0, 1, 2, 3].map((i) => d.attr[i * 4 + 1])).toEqual([1, 1, 2, 3]);
		expect(d.header.tools.map((t) => t.index)).toEqual([1, 2, 3]);
	});

	it('pins layer times to the slicer’s M73 percent points', () => {
		// The estimate says both layers take the same time; the slicer says the first took 3/4.
		const d = parse(
			[
				'; model printing time: 1m 40s; total estimated time: 1m 40s',
				'M83',
				'M73 P0 R1',
				'; CHANGE_LAYER',
				'; Z_HEIGHT: 0.2',
				'G1 X100 E1 F6000',
				'M73 P75 R0',
				'; CHANGE_LAYER',
				'; Z_HEIGHT: 0.4',
				'G1 X0 E1 F6000',
				'M73 P100 R0',
				''
			].join('\n')
		);
		expect(d.header.totalSeconds).toBe(100);
		expect(d.header.layers.map((l) => l.seconds)).toEqual([75, 25]);
	});

	it('estimates layer times from feed rates when the file has no clock', () => {
		const d = parse('M83\nM204 S1000\n; CHANGE_LAYER\nG1 X100 E1 F6000\nG4 P500\n');
		// 100 mm at 100 mm/s with 1000 mm/s² (1 s + 0.1 s ramp) plus a 0.5 s dwell.
		expect(d.header.layers[0].seconds).toBeCloseTo(1.6, 1);
		expect(d.header.totalSeconds).toBe(2);
	});
});

describe('large plates', () => {
	it('over budget: leaves out travel, then joins moves shorter than 0.05 mm, and says so', () => {
		const lines = ['M83', '; CHANGE_LAYER', '; Z_HEIGHT: 0.2'];
		for (let i = 1; i <= 40; i++) lines.push(`G1 X${(i * 0.01).toFixed(2)} E0.001`);
		lines.push('G1 X50', 'G1 X60 E1');
		const d = parse(lines.join('\n'), { budget: 10 });
		expect(d.header.decimated).toEqual({ travel: true, joined: 39 });
		expect(d.header.segments).toBe(2);
		expect(point(d, 0)).toEqual([0, 0, 0, 0.4000000059604645, 0, 0]);
		expect(d.header.layers[0]).toMatchObject({ first: 0, count: 2 });
		const small = parse(lines.join('\n'));
		expect(small.header.decimated).toBeUndefined();
		expect(small.header.segments).toBe(42);
	});

	it('joining short moves keeps a fine curve round instead of turning it into one chord', () => {
		// A circle of radius 2 mm drawn with 0.02 mm moves (about 630 of them).
		const lines = ['M83', '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', 'G1 X2 Y0'];
		const steps = Math.round((2 * Math.PI * 2) / 0.02);
		for (let i = 1; i <= steps; i++) {
			const a = (2 * Math.PI * i) / steps;
			lines.push(`G1 X${(2 * Math.cos(a)).toFixed(5)} Y${(2 * Math.sin(a)).toFixed(5)} E0.001`);
		}
		const d = parse(lines.join('\n'), { budget: 10 });
		expect(d.header.decimated!.joined).toBeGreaterThan(steps / 2);
		// Fewer moves, each short, every corner still on the circle, and together still all the way round.
		expect(d.header.segments).toBeLessThan(steps / 5);
		let around = 0;
		for (let i = 0; i < d.header.segments; i++) {
			const [x0, y0, , x1, y1] = point(d, i);
			const length = Math.hypot(x1 - x0, y1 - y0);
			expect(length).toBeLessThanOrEqual(0.5 + 1e-6);
			expect(Math.hypot(x1, y1)).toBeCloseTo(2, 3);
			around += length;
		}
		expect(around / (4 * Math.PI)).toBeCloseTo(1, 2);
	});
});

describe('packPreview', () => {
	it('writes exactly what encodePreview writes, and decodes back', () => {
		const d = parse(fixture('a1-mini-cube.gcode.3mf'));
		const fast = packPreview(d, TRAVEL_FEATURE);
		expect(fast).toEqual(encodePreview(d));
		const back = decodePreview(fast);
		expect(back.header).toEqual(d.header);
		expect(back.seg).toEqual(d.seg);
		expect(back.attr).toEqual(d.attr);
		expect(back.speed).toEqual(d.speed);
	});

	it('refuses arrays that do not match the count', () => {
		const d = parse('M83\nG1 X1 E1\n');
		expect(() => packPreview({ ...d, speed: new Uint16Array(0) }, TRAVEL_FEATURE)).toThrow(
			/do not match/
		);
	});
});
