import { describe, expect, it } from 'vitest';
import { PREVIEW_FEATURES, decodePreview, encodePreview, type PreviewData } from './preview';
import {
	IDENTITY,
	emptyProject,
	matrix4ToTransform,
	transformToMatrix4,
	type Transform
} from './project';
import { ERROR, PROTOCOL, compatibleProtocol } from './protocol';

function sample(n: number, travel = false): PreviewData {
	const seg = new Float32Array(n * 6).map((_, i) => i * 0.25);
	const attr = new Uint8Array(n * 4).map((_, i) =>
		i % 4 === 0 ? (travel && i === 0 ? 1 : 2) : i % 251
	);
	const speed = new Uint16Array(n).map((_, i) => 100 + i);
	return {
		header: {
			version: 1,
			plate: 2,
			source: 'gcode',
			segments: n,
			bbox: [0, 0, 0, 10, 10, 2],
			features: [...PREVIEW_FEATURES],
			tools: [{ index: 0, color: '#FF7A2F', type: 'PLA' }],
			layers: [{ z: 0.2, height: 0.2, seconds: 12, first: 0, count: n }],
			totalSeconds: 12
		},
		seg,
		attr,
		speed
	};
}

describe('preview container', () => {
	it('round-trips, aligned, with the travel flag', () => {
		for (const n of [0, 1, 3, 1000]) {
			const data = sample(n, n > 0);
			const bytes = encodePreview(data);
			expect(bytes.length % 4).toBe(0);
			expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('PLPV');
			expect(new DataView(bytes.buffer).getUint16(6, true)).toBe(n > 0 ? 1 : 0);
			const back = decodePreview(bytes);
			expect(back.header).toEqual(data.header);
			expect([...back.seg]).toEqual([...data.seg]);
			expect([...back.attr]).toEqual([...data.attr]);
			expect([...back.speed]).toEqual([...data.speed]);
		}
		// A view into a bigger, unaligned buffer decodes too.
		const bytes = encodePreview(sample(5));
		const shifted = new Uint8Array(bytes.length + 3);
		shifted.set(bytes, 3);
		expect(decodePreview(shifted.subarray(3)).header.segments).toBe(5);
	});

	it('refuses malformed input', () => {
		const good = encodePreview(sample(4));
		expect(() => decodePreview(new Uint8Array([1, 2, 3]))).toThrow(/Not a preview/);
		const badMagic = good.slice();
		badMagic[0] = 0;
		expect(() => decodePreview(badMagic)).toThrow(/Not a preview/);
		const badVersion = good.slice();
		new DataView(badVersion.buffer).setUint16(4, 2, true);
		expect(() => decodePreview(badVersion)).toThrow(/version 2/);
		expect(() => decodePreview(good.slice(0, good.length - 4))).toThrow(/segment count/);
		const hugeHeader = good.slice();
		new DataView(hugeHeader.buffer).setUint32(8, 1 << 30, true);
		expect(() => decodePreview(hugeHeader)).toThrow(/header does not fit/);
		const badJson = good.slice();
		badJson[12] = 0x7b + 1;
		expect(() => decodePreview(badJson)).toThrow(/JSON/);
		expect(() => encodePreview({ ...sample(2), speed: new Uint16Array(1) })).toThrow(/match/);
	});
});

describe('project model', () => {
	it('converts 3MF transforms to three.js matrices and back', () => {
		const t: Transform = [0, 1, 0, -1, 0, 0, 0, 0, 1, 10, 20, 5];
		const m = transformToMatrix4(t);
		// A point (1, 0, 0) → (0, 1, 0) + translation, as 3MF's row-vector convention says.
		const x = m[0] * 1 + m[4] * 0 + m[8] * 0 + m[12];
		const y = m[1] * 1 + m[5] * 0 + m[9] * 0 + m[13];
		expect([x, y]).toEqual([10, 21]);
		expect(matrix4ToTransform(m)).toEqual(t);
		expect(transformToMatrix4(IDENTITY)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	});

	it('starts an empty project with one plate and a slot per filament preset', () => {
		const ref = (kind: 'printer' | 'process' | 'filament', name: string) => ({
			kind,
			name,
			source: 'system' as const
		});
		const p = emptyProject({
			printer: ref('printer', 'Bambu Lab P1S 0.4 nozzle'),
			process: ref('process', '0.20mm Standard @BBL X1C'),
			filaments: [
				ref('filament', 'Bambu PLA Basic @BBL X1C'),
				ref('filament', 'Bambu PETG HF @BBL X1C')
			]
		});
		expect(p.plates).toHaveLength(1);
		expect(p.filaments.map((f) => f.index)).toEqual([1, 2]);
	});
});

describe('engine protocol', () => {
	it('negotiates on the major version only', () => {
		expect(compatibleProtocol({ major: PROTOCOL.major, minor: 7 })).toBe(true);
		expect(compatibleProtocol({ major: PROTOCOL.major + 1, minor: 0 })).toBe(false);
		expect(ERROR.CANCELLED).toBe(1030);
	});
});
