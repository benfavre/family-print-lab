// Turning a statistics summary into what the dashboard draws: date presets, month columns, colour
// per material and per person. Pure functions, tested in view.test.ts.
import type { AnalyticsSummary, MonthMaterial } from '$lib/shared/analytics';
import type { ProfileColor } from '$lib/shared/domain';
import { TONES, type Tone } from '$lib/components/charts/scale';

export const RANGES = [
	{ id: '30d', label: '30 days' },
	{ id: '90d', label: '90 days' },
	{ id: '12m', label: '12 months' },
	{ id: 'all', label: 'All time' }
] as const;
export type RangeId = (typeof RANGES)[number]['id'];

/** A local date as YYYY-MM-DD. */
export const localDay = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The from/to days of a preset, ending today (local). */
export function rangeDates(
	id: RangeId,
	today = new Date()
): { from: string | null; to: string | null } {
	if (id === 'all') return { from: null, to: null };
	const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	if (id === '12m')
		start.setFullYear(start.getFullYear() - 1, start.getMonth(), start.getDate() + 1);
	else start.setDate(start.getDate() - (id === '30d' ? 29 : 89));
	return { from: localDay(start), to: localDay(today) };
}

/** Which preset a from/to pair is, or null for a custom range. */
export function rangeOf(
	from: string | null,
	to: string | null,
	today = new Date()
): RangeId | null {
	return (
		RANGES.find((r) => {
			const d = rangeDates(r.id, today);
			return d.from === from && d.to === to;
		})?.id ?? null
	);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-09" → "Sep 26" ("Sep" when every month is in one year). */
export const monthLabel = (month: string, withYear = true) =>
	`${MONTHS[Number(month.slice(5, 7)) - 1]}${withYear ? ` ${month.slice(2, 4)}` : ''}`;
/** "2026-09-07" → "7 Sep". */
export const weekLabel = (day: string) =>
	`${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

/** Every month from first to last (YYYY-MM), gaps filled. */
export function monthsBetween(first: string, last: string): string[] {
	const out: string[] = [];
	let [y, m] = first.split('-').map(Number);
	const [ly, lm] = last.split('-').map(Number);
	while ((y < ly || (y === ly && m <= lm)) && out.length < 240) {
		out.push(`${y}-${String(m).padStart(2, '0')}`);
		if (++m > 12) [y, m] = [y + 1, 1];
	}
	return out;
}

/**
 * Colours for materials: the most-used five get the fixed colour order, the rest share "Other" (dim),
 * so the donut and the monthly bars agree.
 */
export function materialTones(s: Pick<AnalyticsSummary, 'byMaterial'>, keep = 5) {
	const top = s.byMaterial.filter((m) => m.grams > 0).slice(0, keep);
	const tones = new Map<string, Tone>(top.map((m, i) => [m.key, TONES[i]]));
	return { tones, other: s.byMaterial.filter((m) => m.grams > 0).length > keep };
}

export const OTHER = 'Other';

/** Monthly filament split by material (top five and "Other"), with empty months filled in. */
export function monthlyStacks(months: MonthMaterial[], tones: Map<string, Tone>, other: boolean) {
	if (!months.length) return { columns: [], series: [], values: [] };
	const keys = monthsBetween(months[0].month, months.at(-1)!.month);
	const oneYear = keys[0].slice(0, 4) === keys.at(-1)!.slice(0, 4);
	const series = [
		...[...tones].map(([key, tone]) => ({ key, label: key, tone })),
		...(other ? [{ key: OTHER, label: OTHER, tone: 'dim' as Tone }] : [])
	];
	const index = new Map(series.map((s, i) => [s.key, i]));
	const values = keys.map(() => series.map(() => 0));
	for (const m of months) {
		const col = keys.indexOf(m.month);
		const s = index.get(tones.has(m.material) ? m.material : OTHER);
		if (col >= 0 && s !== undefined) values[col][s] += m.grams;
	}
	return {
		columns: keys.map((key) => ({ key, label: monthLabel(key, !oneYear) })),
		series,
		values
	};
}

/** A person's profile colour as a chart tone. */
export const PERSON_TONE: Record<ProfileColor, Tone> = {
	violet: 'violet',
	blue: 'blue',
	orange: 'amber',
	pink: 'pink',
	green: 'lime'
};

export const percent = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
