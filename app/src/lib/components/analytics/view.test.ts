import { describe, expect, it } from 'vitest';
import {
	materialTones,
	monthLabel,
	monthlyStacks,
	monthsBetween,
	percent,
	rangeDates,
	rangeOf,
	weekLabel
} from './view';

const today = new Date(2026, 8, 27, 15, 0); // 27 Sep 2026, local

describe('dashboard view helpers', () => {
	it('turns presets into local dates ending today', () => {
		expect(rangeDates('30d', today)).toEqual({ from: '2026-08-29', to: '2026-09-27' });
		expect(rangeDates('90d', today)).toEqual({ from: '2026-06-30', to: '2026-09-27' });
		expect(rangeDates('12m', today)).toEqual({ from: '2025-09-28', to: '2026-09-27' });
		expect(rangeDates('all', today)).toEqual({ from: null, to: null });
		expect(rangeOf('2026-08-29', '2026-09-27', today)).toBe('30d');
		expect(rangeOf(null, null, today)).toBe('all');
		expect(rangeOf('2026-01-01', '2026-02-01', today)).toBeNull();
	});

	it('fills months and labels them', () => {
		expect(monthsBetween('2025-11', '2026-02')).toEqual([
			'2025-11',
			'2025-12',
			'2026-01',
			'2026-02'
		]);
		expect(monthsBetween('2026-03', '2026-03')).toEqual(['2026-03']);
		expect(monthLabel('2026-09')).toBe('Sep 26');
		expect(monthLabel('2026-09', false)).toBe('Sep');
		expect(weekLabel('2026-09-07')).toBe('7 Sep');
		expect(percent(0.805)).toBe('81%');
		expect(percent(null)).toBe('—');
	});

	it('gives the top materials fixed colours and folds the rest into Other', () => {
		const byMaterial = ['PLA', 'PETG', 'TPU', 'ABS', 'ASA', 'PC', 'PA'].map((key, i) => ({
			key,
			label: key,
			grams: 100 - i,
			cost: null,
			uncostedGrams: 0,
			prints: 1
		}));
		const { tones, other } = materialTones({ byMaterial });
		expect([...tones]).toEqual([
			['PLA', 'cyan'],
			['PETG', 'violet'],
			['TPU', 'lime'],
			['ABS', 'amber'],
			['ASA', 'pink']
		]);
		expect(other).toBe(true);
		const stacks = monthlyStacks(
			[
				{ month: '2026-07', material: 'PLA', grams: 10, cost: null },
				{ month: '2026-09', material: 'PC', grams: 5, cost: null },
				{ month: '2026-09', material: 'PA', grams: 2, cost: null }
			],
			tones,
			other
		);
		expect(stacks.columns.map((c) => c.label)).toEqual(['Jul', 'Aug', 'Sep']);
		expect(stacks.series.map((s) => s.key)).toEqual(['PLA', 'PETG', 'TPU', 'ABS', 'ASA', 'Other']);
		expect(stacks.values).toEqual([
			[10, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0, 7]
		]);
		expect(monthlyStacks([], tones, other).columns).toEqual([]);
	});

	it('runs the monthly columns over the filter dates, like the weekly chart', () => {
		const one = [{ month: '2026-08', material: 'PLA', grams: 10, cost: null }];
		const tones = new Map([['PLA', 'cyan' as const]]);
		const span = { from: '2026-06-15', to: '2026-09-27' };
		expect(monthlyStacks(one, tones, false, span).columns.map((c) => c.key)).toEqual([
			'2026-06',
			'2026-07',
			'2026-08',
			'2026-09'
		]);
		expect(monthlyStacks(one, tones, false, span).values).toEqual([[0], [0], [10], [0]]);
		// All time: first to last month with filament.
		expect(monthlyStacks(one, tones, false).columns.map((c) => c.key)).toEqual(['2026-08']);
		// A range across new year labels months with their year.
		const years = monthlyStacks(one, tones, false, { from: '2025-12-01', to: null });
		expect(years.columns.map((c) => c.label)).toEqual([
			'Dec 25',
			'Jan 26',
			'Feb 26',
			'Mar 26',
			'Apr 26',
			'May 26',
			'Jun 26',
			'Jul 26',
			'Aug 26'
		]);
	});
});
