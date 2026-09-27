// The kids' pure rules: calendar windows across time zones and DST, the limit checks, grams
// estimates, badges and photo sniffing.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from '$lib/server/ffmpeg';
import { estimateGrams, NO_LIMITS } from '$lib/shared/kids';
import { startOfLocalDay, weekKey, windowStart } from './windows';
import { blockedNow, checkLimits, usageOf } from './limits';
import { earnedBadges, type PrintedThing } from './badges';
import { decodePhoto, fitSnapshot, MAX_PHOTO_BYTES, sniffPhoto } from './images';

const at = (iso: string) => new Date(iso);
const ffmpeg = findFfmpeg();
const start = (iso: string, period: 'day' | 'week' | 'month', tz: string) =>
	windowStart(at(iso), period, tz).toISOString();

describe('windowStart', () => {
	it('starts the day at local midnight', () => {
		expect(start('2026-09-27T10:00:00Z', 'day', 'UTC')).toBe('2026-09-27T00:00:00.000Z');
		// 01:30 in Paris (UTC+2 in summer) is still the 27th there.
		expect(start('2026-09-26T23:30:00Z', 'day', 'Europe/Paris')).toBe('2026-09-26T22:00:00.000Z');
		// 20:00 in Los Angeles on the 26th is already the 27th in UTC.
		expect(start('2026-09-27T03:00:00Z', 'day', 'America/Los_Angeles')).toBe(
			'2026-09-26T07:00:00.000Z'
		);
		expect(start('2026-09-27T12:00:00Z', 'day', 'Asia/Kolkata')).toBe('2026-09-26T18:30:00.000Z');
	});

	it('starts the week on Monday, across a month and a year end', () => {
		// Sunday 27 September 2026 → Monday 21.
		expect(start('2026-09-27T10:00:00Z', 'week', 'UTC')).toBe('2026-09-21T00:00:00.000Z');
		// Monday itself.
		expect(start('2026-09-28T00:00:00Z', 'week', 'UTC')).toBe('2026-09-28T00:00:00.000Z');
		// Friday 1 January 2027 → Monday 28 December 2026.
		expect(start('2027-01-01T12:00:00Z', 'week', 'UTC')).toBe('2026-12-28T00:00:00.000Z');
		// Sunday 23:30 UTC is already Monday in Tokyo.
		expect(start('2026-09-27T23:30:00Z', 'week', 'Asia/Tokyo')).toBe('2026-09-27T15:00:00.000Z');
	});

	it('starts the month on the 1st, in the local zone', () => {
		expect(start('2026-09-27T10:00:00Z', 'month', 'UTC')).toBe('2026-09-01T00:00:00.000Z');
		// 30 September 23:30 UTC is 1 October in Paris.
		expect(start('2026-09-30T23:30:00Z', 'month', 'Europe/Paris')).toBe('2026-09-30T22:00:00.000Z');
	});

	it('handles days that change clocks', () => {
		// Paris springs forward on 29 March 2026 at 02:00: midnight is still UTC+1.
		expect(start('2026-03-29T12:00:00Z', 'day', 'Europe/Paris')).toBe('2026-03-28T23:00:00.000Z');
		expect(start('2026-03-30T12:00:00Z', 'day', 'Europe/Paris')).toBe('2026-03-29T22:00:00.000Z');
		// Havana skips midnight (00:00 → 01:00) on 8 March 2026: the day starts at 01:00 local.
		expect(startOfLocalDay(2026, 3, 8, 'America/Havana').toISOString()).toBe(
			'2026-03-08T05:00:00.000Z'
		);
	});

	it('names weeks by their Monday', () => {
		expect(weekKey(at('2026-09-27T10:00:00Z'), 'UTC')).toBe('2026-09-21');
		expect(weekKey(at('2026-09-27T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-09-28');
	});
});

describe('limits', () => {
	const now = at('2026-09-24T15:00:00Z'); // a Thursday
	const asks = [
		{ at: '2026-09-24T09:00:00.000Z', grams: 10 }, // today
		{ at: '2026-09-22T09:00:00.000Z', grams: 20 }, // this week
		{ at: '2026-09-18T09:00:00.000Z', grams: 30 }, // last week, this month
		{ at: '2026-08-30T09:00:00.000Z', grams: 40 } // last month
	];

	it('counts what was asked for today, this week and this month', () => {
		expect(usageOf(asks, now, 'UTC')).toEqual({
			printsToday: 1,
			printsThisWeek: 2,
			gramsThisWeek: 30,
			gramsThisMonth: 60
		});
		// In Tokyo it is already Friday 00:00 at 15:00 UTC: Thursday's request is not today.
		expect(usageOf(asks, now, 'Asia/Tokyo').printsToday).toBe(0);
	});

	it('says no kindly, naming the first limit reached', () => {
		const usage = usageOf(asks, now, 'UTC');
		expect(checkLimits(NO_LIMITS, usage, 500)).toMatchObject({
			ok: true,
			reason: null,
			message: ''
		});
		const day = checkLimits({ ...NO_LIMITS, printsPerDay: 1, printsPerWeek: 1 }, usage, 5);
		expect(day).toMatchObject({ ok: false, reason: 'day' });
		expect(day.message).toMatch(/all the printing for today/);
		expect(day.parentText).toBe('Daily limit reached (1 of 1 today).');
		expect(checkLimits({ ...NO_LIMITS, printsPerWeek: 2 }, usage, 5).reason).toBe('week');
		expect(checkLimits({ ...NO_LIMITS, gramsPerWeek: 40 }, usage, 10).ok).toBe(true);
		expect(checkLimits({ ...NO_LIMITS, gramsPerWeek: 40 }, usage, 11).reason).toBe('grams-week');
		expect(checkLimits({ ...NO_LIMITS, gramsPerMonth: 100 }, usage, 41).reason).toBe('grams-month');
		expect(checkLimits({ ...NO_LIMITS, printsPerDay: 0 }, usageOf([], now, 'UTC'), 1).reason).toBe(
			'day'
		);
	});

	it('says yes without asking only for small prints within the limits', () => {
		const usage = usageOf([], now, 'UTC');
		const small = { ...NO_LIMITS, needApprovalOverGrams: 15 };
		expect(checkLimits(small, usage, 15).autoApprove).toBe(true);
		expect(checkLimits(small, usage, 16).autoApprove).toBe(false);
		// An unknown weight (no volume) always goes to a grown-up.
		expect(checkLimits(small, usage, 0).autoApprove).toBe(false);
		expect(checkLimits(NO_LIMITS, usage, 1).autoApprove).toBe(false);
		expect(checkLimits({ ...small, printsPerDay: 0 }, usage, 1).autoApprove).toBe(false);
	});

	it('knows when nothing at all can be asked for', () => {
		const usage = usageOf(asks, now, 'UTC');
		expect(blockedNow({ ...NO_LIMITS, printsPerDay: 1 }, usage)).toMatch(/tomorrow/);
		expect(blockedNow({ ...NO_LIMITS, printsPerWeek: 2 }, usage)).toMatch(/Monday/);
		expect(blockedNow({ ...NO_LIMITS, gramsPerWeek: 1 }, usage)).toBeNull();
	});
});

describe('estimateGrams', () => {
	it('weighs a solid part by material', () => {
		expect(estimateGrams(10_000)).toBe(12);
		expect(estimateGrams(10_000, 'PLA Matte')).toBe(12);
		expect(estimateGrams(10_000, 'PETG HF')).toBe(13);
		expect(estimateGrams(10_000, 'ABS')).toBe(10);
		expect(estimateGrams(10_000, 'Mystery')).toBe(12);
		expect(estimateGrams(-5)).toBe(0);
	});
});

describe('badges', () => {
	const thing = (n: number, o: Partial<PrintedThing> = {}): PrintedThing => ({
		jobId: `j${n}`,
		at: new Date(Date.UTC(2026, 8, 1 + n)).toISOString(),
		colours: ['#ff0000'],
		fromScratch: false,
		...o
	});

	it('earns nothing without prints, then the first print', () => {
		expect(earnedBadges([], 'UTC')).toEqual([]);
		expect(earnedBadges([thing(1)], 'UTC')).toEqual([
			{ badge: 'first-print', jobId: 'j1', at: thing(1).at }
		]);
	});

	it('counts 5, 10 and 25 prints, in time order', () => {
		const many = Array.from({ length: 25 }, (_, i) => thing(i)).reverse();
		const got = Object.fromEntries(earnedBadges(many, 'UTC').map((e) => [e.badge, e.jobId]));
		expect(got).toMatchObject({
			'first-print': 'j0',
			'prints-5': 'j4',
			'prints-10': 'j9',
			'prints-25': 'j24'
		});
	});

	it('earns colour, design and streak badges with the print that did it', () => {
		const got = (list: PrintedThing[]) =>
			Object.fromEntries(earnedBadges(list, 'UTC').map((e) => [e.badge, e.jobId]));
		expect(got([thing(1), thing(2, { colours: ['#ff0000', '#00ff00'] })])['multi-colour']).toBe(
			'j2'
		);
		expect(got([thing(1, { colours: ['#ff0000', '#ff0000'] })])['multi-colour']).toBeUndefined();
		expect(got([thing(1), thing(2, { fromScratch: true })])['from-scratch']).toBe('j2');
		expect(
			got([thing(1), thing(2, { colours: ['#00ff00'] }), thing(3, { colours: ['#0000ff'] })])
				.rainbow
		).toBe('j3');
		// Weeks of 31 Aug, 7 Sep and 14 Sep 2026 (a gap first, so the streak starts over).
		const weekly = [
			thing(0, { at: '2026-08-10T10:00:00.000Z' }),
			thing(1, { at: '2026-08-31T10:00:00.000Z' }),
			thing(2, { at: '2026-09-08T10:00:00.000Z' }),
			thing(3, { at: '2026-09-09T10:00:00.000Z' }),
			thing(4, { at: '2026-09-20T10:00:00.000Z' })
		];
		expect(got(weekly)['week-streak']).toBe('j4');
		expect(got(weekly.slice(0, 4))['week-streak']).toBeUndefined();
	});
});

describe('photos', () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
	const webp = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(8)]);

	it('accepts JPEG and WebP only, 400 KB at most', () => {
		expect(sniffPhoto(jpeg)).toBe('image/jpeg');
		expect(sniffPhoto(webp)).toBe('image/webp');
		expect(sniffPhoto(Buffer.from('\x89PNG\r\n\x1a\n'))).toBeNull();
		expect(decodePhoto(`data:image/webp;base64,${webp.toString('base64')}`).mime).toBe(
			'image/webp'
		);
		expect(decodePhoto(jpeg.toString('base64')).image).toEqual(jpeg);
		expect(() => decodePhoto(Buffer.from('GIF89a').toString('base64'))).toThrow(/JPEG or WebP/);
		const big = Buffer.concat([jpeg, Buffer.alloc(MAX_PHOTO_BYTES)]);
		expect(() => decodePhoto(big.toString('base64'))).toThrow(/too large/);
	});

	it('keeps small snapshots as they are', async () => {
		expect(await fitSnapshot(jpeg)).toBe(jpeg);
		await expect(fitSnapshot(webp)).rejects.toThrow(/JPEG/);
	});

	it.skipIf(!ffmpeg)(
		'scales large snapshots down with ffmpeg',
		async () => {
			// A noisy 2560×1440 frame at best quality is well over 400 KB.
			const big = spawnSync(
				ffmpeg!,
				[
					...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
					...['-i', 'nullsrc=s=2560x1440,geq=random(1)*255:128:128', '-frames:v', '1'],
					...['-q:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']
				],
				{ maxBuffer: 50e6 }
			).stdout;
			expect(big.length).toBeGreaterThan(MAX_PHOTO_BYTES);
			const small = await fitSnapshot(big, { bin: ffmpeg! });
			expect(sniffPhoto(small)).toBe('image/jpeg');
			expect(small.length).toBeLessThanOrEqual(MAX_PHOTO_BYTES);
		},
		30_000
	);
});
