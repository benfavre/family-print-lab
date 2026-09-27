import { describe, expect, it } from 'vitest';
import {
	FEATURE_COLOURS,
	clock,
	featuresUsed,
	hexRgb,
	rampRgb,
	segmentColours,
	speedRange
} from './gcode-preview';
import { PREVIEW_FEATURES, type PreviewData } from './slicer/preview';

const F = (name: (typeof PREVIEW_FEATURES)[number]) => PREVIEW_FEATURES.indexOf(name);

/** Three segments: an outer wall on filament 0 at 50 mm/s, a travel, sparse infill on filament 1 at 250. */
const data: PreviewData = {
	header: {
		version: 1,
		plate: 1,
		source: 'gcode',
		segments: 3,
		bbox: [0, 0, 0, 1, 1, 1],
		features: [...PREVIEW_FEATURES],
		tools: [
			{ index: 0, color: '#FF0000', type: 'PLA' },
			{ index: 1, color: '#0000FF', type: 'PETG' }
		],
		layers: [{ z: 0.2, height: 0.2, seconds: 1, first: 0, count: 3 }],
		totalSeconds: 1
	},
	seg: new Float32Array(18),
	attr: new Uint8Array([
		F('Outer wall'),
		0,
		42,
		20,
		F('Travel'),
		0,
		0,
		0,
		F('Sparse infill'),
		1,
		45,
		20
	]),
	speed: new Uint16Array([50, 500, 250])
};

describe('toolpath colours', () => {
	it('has a colour for every feature name', () => {
		for (const f of PREVIEW_FEATURES) expect(FEATURE_COLOURS[f]).toMatch(/^#[0-9a-f]{6}$/);
	});

	it('colours by feature, with hidden features see-through', () => {
		const c = segmentColours(data, 'feature', new Set([F('Travel')]));
		expect([...c.subarray(0, 4)]).toEqual([...hexRgb(FEATURE_COLOURS['Outer wall']), 255]);
		expect([...c.subarray(4, 8)]).toEqual([...c.subarray(0, 4)]); // both ends of a segment
		expect(c[8 + 3]).toBe(0);
		expect([...c.subarray(16, 19)]).toEqual(hexRgb(FEATURE_COLOURS['Sparse infill']));
	});

	it('colours by filament and by speed; travel keeps its own colour', () => {
		const byTool = segmentColours(data, 'filament', new Set());
		expect([...byTool.subarray(0, 3)]).toEqual([255, 0, 0]);
		expect([...byTool.subarray(16, 19)]).toEqual([0, 0, 255]);
		expect([...byTool.subarray(8, 11)]).toEqual(hexRgb(FEATURE_COLOURS.Travel));
		const bySpeed = segmentColours(data, 'speed', new Set());
		expect([...bySpeed.subarray(0, 3)]).toEqual(rampRgb(0)); // slowest
		expect([...bySpeed.subarray(16, 19)]).toEqual(rampRgb(1)); // fastest
	});

	it('speed range and feature counts leave travel out of the speeds', () => {
		expect(speedRange(data)).toEqual([50, 250]);
		expect(featuresUsed(data)).toEqual([
			{ code: F('Travel'), name: 'Travel', count: 1 },
			{ code: F('Outer wall'), name: 'Outer wall', count: 1 },
			{ code: F('Sparse infill'), name: 'Sparse infill', count: 1 }
		]);
	});

	it('reads hex colours, and falls back to grey', () => {
		expect(hexRgb('#00AE42')).toEqual([0, 174, 66]);
		expect(hexRgb('00AE42FF')).toEqual([0, 174, 66]);
		expect(hexRgb('nope')).toEqual([136, 136, 136]);
		expect(rampRgb(0.5)).toHaveLength(3);
	});
});

describe('clock', () => {
	it('says seconds, minutes or hours', () => {
		expect(clock(null)).toBe('—');
		expect(clock(34.4)).toBe('34 s');
		expect(clock(320)).toBe('5 min 20 s');
		expect(clock(600)).toBe('10 min');
		expect(clock(7500)).toBe('2 h 05 min');
		expect(clock(7170)).toBe('2 h 00 min');
	});
});
