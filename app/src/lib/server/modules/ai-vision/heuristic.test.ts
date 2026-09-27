// The rough check on the simulated print pictures (sim/features/vision-fixtures.ts): a good print from
// the first layer to the end stays "ok" under a moving toolhead, spaghetti is flagged, a knocked-over
// part is "unsure". The decoding tests need ffmpeg and are skipped without it.
import { describe, expect, it } from 'vitest';
import {
	VISION_DETACHED,
	VISION_LAYERS,
	VISION_SPAGHETTI
} from '$lib/server/printer/sim/features/vision-fixtures';
import { analyse, decodeGrey, GREY_H, GREY_W, greyArgs, judge } from './heuristic';
import { findFfmpeg } from '$lib/server/ffmpeg';

const ffmpeg = findFfmpeg();
const jpeg = (b64: string) => Buffer.from(b64, 'base64');
const frame = async (b64: string) => analyse(await decodeGrey(ffmpeg!, jpeg(b64)));

/** A flat picture with an optional block of stripes (an edge-dense area). */
function synthetic(stripes?: { x: number; y: number; w: number; h: number }) {
	const grey = new Uint8Array(GREY_W * GREY_H).fill(60);
	if (stripes)
		for (let y = stripes.y; y < stripes.y + stripes.h; y++)
			for (let x = stripes.x; x < stripes.x + stripes.w; x++)
				grey[y * GREY_W + x] = (x + y) % 4 < 2 ? 220 : 40;
	return grey;
}

describe('judge', () => {
	it('says ok when nothing changed', () => {
		const a = analyse(synthetic());
		expect(judge(a, null, analyse(synthetic()))).toMatchObject({ verdict: 'ok', cells: 0 });
	});

	it('flags an area that suddenly fills with edges as spaghetti, at most 90 % sure', () => {
		const ref = analyse(synthetic());
		const r = judge(ref, null, analyse(synthetic({ x: 40, y: 40, w: 80, h: 40 })));
		expect(r.verdict).toBe('spaghetti');
		expect(r.cells).toBeGreaterThanOrEqual(8);
		expect(r.confidence).toBeLessThanOrEqual(0.9);
		expect(r.confidence).toBeGreaterThan(0.75);
	});

	it('does not flag edges that were already there in the last good picture', () => {
		const busy = analyse(synthetic({ x: 40, y: 40, w: 80, h: 40 }));
		const r = judge(analyse(synthetic()), busy, analyse(synthetic({ x: 40, y: 40, w: 80, h: 40 })));
		expect(r.verdict).not.toBe('spaghetti');
	});

	it('refuses a picture of the wrong size', () => {
		expect(() => analyse(new Uint8Array(10))).toThrow(/size/);
	});
});

describe('ffmpeg decoding', () => {
	it('asks for 160×120 greyscale', () => {
		const args = greyArgs();
		expect(args.join(' ')).toContain('-f rawvideo -pix_fmt gray -s 160x120');
	});

	it.skipIf(!ffmpeg)('keeps a good print ok from the first layer to the end', async () => {
		const ref = await frame(VISION_LAYERS[0]);
		let prev = ref;
		for (const layer of VISION_LAYERS.slice(1)) {
			const current = await frame(layer);
			const r = judge(ref, prev, current);
			expect(r.verdict, r.reason).toBe('ok');
			prev = current;
		}
	});

	it.skipIf(!ffmpeg)('flags the spaghetti picture above the default threshold', async () => {
		const ref = await frame(VISION_LAYERS[0]);
		const r = judge(ref, await frame(VISION_LAYERS[2]), await frame(VISION_SPAGHETTI));
		expect(r.verdict).toBe('spaghetti');
		expect(r.confidence).toBeGreaterThanOrEqual(0.75);
	});

	it.skipIf(!ffmpeg)('keeps flagging spaghetti on later checks', async () => {
		const ref = await frame(VISION_LAYERS[0]);
		// The last good picture stays the one before the spaghetti.
		const r = judge(ref, await frame(VISION_LAYERS[3]), await frame(VISION_SPAGHETTI));
		expect(r.verdict).toBe('spaghetti');
	});

	it.skipIf(!ffmpeg)('is unsure when the part moved', async () => {
		const ref = await frame(VISION_LAYERS[0]);
		const r = judge(ref, await frame(VISION_LAYERS[3]), await frame(VISION_DETACHED));
		expect(r.verdict).toBe('unsure');
	});

	it.skipIf(!ffmpeg)('says why when the picture is not a JPEG', async () => {
		await expect(decodeGrey(ffmpeg!, Buffer.from('not a picture'))).rejects.toThrow(
			/could not read/
		);
	});
});
