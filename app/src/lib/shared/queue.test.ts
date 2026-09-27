import { describe, expect, it } from 'vitest';
import {
	defaultQueueSettings,
	inQuietHours,
	planTimeline,
	quietSpans,
	quietUntil,
	type QuietWindow
} from './queue';

/** Local time: 2026-09-28 is a Monday. */
const at = (day: number, h: number, m = 0) => new Date(2026, 8, 27 + day, h, m);
const week = (over: Record<number, Partial<QuietWindow>>) =>
	defaultQueueSettings().quietHours.map((w, i) => ({ ...w, ...over[i] }));

describe('quiet hours', () => {
	// Monday night 22:00 → Tuesday 07:00; Tuesday 13:00–14:00.
	const quiet = week({
		1: { on: true, start: '22:00', end: '07:00' },
		2: { on: true, start: '13:00', end: '14:00' }
	});

	it.each([
		['Monday afternoon', at(1, 15), false],
		['Monday at the start', at(1, 22), true],
		['Monday just before midnight', at(1, 23, 59), true],
		['Tuesday after midnight (Monday’s window)', at(2, 3), true],
		['Tuesday at the end', at(2, 7), false],
		['Tuesday lunch', at(2, 13, 30), true],
		['Tuesday night (no window)', at(2, 23), false],
		['Sunday night (switched off)', at(0, 23), false]
	])('%s → %s', (_label, when, expected) => {
		expect(inQuietHours(when, quiet)).toBe(expected);
	});

	it('says when quiet hours end, across midnight', () => {
		expect(quietUntil(at(1, 23), quiet)).toEqual(at(2, 7));
		expect(quietUntil(at(1, 15), quiet)).toEqual(at(1, 15));
	});

	it('follows back-to-back windows', () => {
		const chained = week({
			1: { on: true, start: '22:00', end: '07:00' },
			2: { on: true, start: '06:00', end: '09:00' }
		});
		expect(quietUntil(at(1, 23), chained)).toEqual(at(2, 9));
	});

	it('ignores a window whose start and end are the same', () => {
		expect(inQuietHours(at(1, 12), week({ 1: { on: true, start: '12:00', end: '12:00' } }))).toBe(
			false
		);
	});

	it('lists spans clipped to a range, for shading', () => {
		expect(quietSpans(at(1, 20), at(2, 20), quiet)).toEqual([
			{ start: at(1, 22), end: at(2, 7) },
			{ start: at(2, 13), end: at(2, 14) }
		]);
		expect(quietSpans(at(2, 3), at(2, 5), quiet)).toEqual([{ start: at(2, 3), end: at(2, 5) }]);
	});
});

describe('timeline', () => {
	const now = at(1, 20).getTime();
	const printers = [
		{ id: 'x2d', model: 'N6', busyUntil: now + 30 * 60_000 },
		{ id: 'p1s', model: 'C12', busyUntil: null }
	];
	const none = defaultQueueSettings().quietHours;

	it('queues a printer’s own items after its current print, then “any” items where they fit first', () => {
		const { blocks, unplaced } = planTimeline({
			now,
			printers,
			quiet: none,
			items: [
				{ id: 'a', printerId: 'x2d', minutes: 60, notBefore: null, slicedFor: 'N6' },
				{ id: 'b', printerId: null, minutes: 20, notBefore: null, slicedFor: 'N6' },
				{ id: 'c', printerId: null, minutes: null, notBefore: null, slicedFor: null },
				{ id: 'd', printerId: null, minutes: 10, notBefore: null, slicedFor: 'N1' }
			]
		});
		const by = (id: string | null) => blocks.find((b) => b.itemId === id)!;
		expect(by(null)).toMatchObject({ printerId: 'x2d', start: now, end: now + 30 * 60_000 });
		expect(by('a')).toMatchObject({ start: now + 30 * 60_000, end: now + 90 * 60_000 });
		// Only the X2D fits b, so it waits for a.
		expect(by('b')).toMatchObject({ printerId: 'x2d', start: now + 90 * 60_000 });
		// c fits anything; the P1S is free now. No estimate: an hour, marked as a guess.
		expect(by('c')).toMatchObject({ printerId: 'p1s', start: now, guessed: true });
		expect(by('c').end - by('c').start).toBe(60 * 60_000);
		expect(unplaced).toEqual(['d']);
	});

	it('starts after quiet hours and not-before times', () => {
		const quiet = week({ 1: { on: true, start: '21:00', end: '07:00' } });
		const { blocks } = planTimeline({
			now,
			printers: [{ id: 'p1s', model: 'C12', busyUntil: null }],
			quiet,
			items: [
				{ id: 'a', printerId: 'p1s', minutes: 90, notBefore: null, slicedFor: 'C12' },
				{ id: 'b', printerId: 'p1s', minutes: 30, notBefore: at(2, 9).getTime(), slicedFor: null }
			]
		});
		// a starts now and runs into quiet hours (they only stop starts); b waits for its time.
		expect(blocks.map((b) => [b.itemId, new Date(b.start)])).toEqual([
			['a', at(1, 20)],
			['b', at(2, 9)]
		]);
		const late = planTimeline({
			now: at(1, 22).getTime(),
			printers: [{ id: 'p1s', model: 'C12', busyUntil: null }],
			quiet,
			items: [{ id: 'a', printerId: 'p1s', minutes: 30, notBefore: null, slicedFor: null }]
		});
		expect(new Date(late.blocks[0].start)).toEqual(at(2, 7));
	});
});
