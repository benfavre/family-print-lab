// Small helpers for the SVG charts: nice axis ends and ticks, linear scales, donut arcs, stacking and
// the fixed colour order (theme variables from app.css, never generated hues).

/** Series colours in a fixed order; a series keeps its colour when others are filtered out. */
export const TONES = ['cyan', 'violet', 'lime', 'amber', 'pink', 'blue'] as const;
export type Tone = (typeof TONES)[number] | 'dim' | 'red';
/** The CSS colour for a tone. */
export const toneColor = (tone: Tone) => (tone === 'dim' ? 'var(--dim)' : `var(--${tone})`);

/** The smallest "nice" number (1, 2, 2.5, 5 × 10ⁿ) at or above v; 1 for nothing. */
export function niceCeil(v: number): number {
	if (!(v > 0) || !Number.isFinite(v)) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	const f = v / p;
	const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
	return +(step * p).toPrecision(12);
}

/** Axis ticks from 0 to a nice top that covers max, about `count` steps. */
export function ticks(max: number, count = 4): number[] {
	const step = niceCeil((max > 0 ? max : 1) / count);
	const top = Math.max(step, Math.ceil(+((max > 0 ? max : 1) / step).toFixed(9)) * step);
	const out: number[] = [];
	for (let v = 0; v <= top + step / 1e6; v += step) out.push(+v.toPrecision(12));
	return out;
}

/** A linear map from [d0, d1] to [r0, r1] (a flat domain maps to r0). */
export function linear([d0, d1]: [number, number], [r0, r1]: [number, number]) {
	const span = d1 - d0;
	return (v: number) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0));
}

/** An SVG path for a line through points, broken where a value is missing. */
export function linePath(points: ({ x: number; y: number } | null)[]): string {
	let d = '',
		pen = false;
	for (const p of points) {
		if (!p) {
			pen = false;
			continue;
		}
		d += `${pen ? 'L' : 'M'}${+p.x.toFixed(2)},${+p.y.toFixed(2)}`;
		pen = true;
	}
	return d;
}

/**
 * A donut segment from angle a0 to a1 (radians, 0 at 12 o'clock, clockwise) between radii r and
 * inner. A full turn is drawn as two halves so the arc does not collapse.
 */
export function arc(
	cx: number,
	cy: number,
	r: number,
	inner: number,
	a0: number,
	a1: number
): string {
	if (a1 - a0 >= Math.PI * 2 - 1e-9) {
		const mid = a0 + Math.PI;
		return `${arc(cx, cy, r, inner, a0, mid)} ${arc(cx, cy, r, inner, mid, a0 + Math.PI * 2)}`;
	}
	const pt = (rad: number, a: number) =>
		`${+(cx + rad * Math.sin(a)).toFixed(3)},${+(cy - rad * Math.cos(a)).toFixed(3)}`;
	const large = a1 - a0 > Math.PI ? 1 : 0;
	return [
		`M${pt(r, a0)}`,
		`A${r},${r} 0 ${large} 1 ${pt(r, a1)}`,
		`L${pt(inner, a1)}`,
		`A${inner},${inner} 0 ${large} 0 ${pt(inner, a0)}`,
		'Z'
	].join(' ');
}

/** Donut angles for values: each slice's start and end (radians), zero and negative values skipped. */
export function slices<T extends { value: number }>(items: T[]) {
	const total = items.reduce((n, i) => n + Math.max(0, i.value), 0);
	let at = 0;
	return items
		.filter((i) => i.value > 0 && total > 0)
		.map((item) => {
			const a0 = at;
			at += (item.value / total) * Math.PI * 2;
			return { item, a0, a1: at, share: item.value / total };
		});
}

/** Stacks values per column: each segment's bottom (y0) and top (y1), in series order. */
export function stack(columns: number[][]): { y0: number; y1: number }[][] {
	return columns.map((values) => {
		let y = 0;
		return values.map((v) => {
			const y0 = y;
			y += Math.max(0, v);
			return { y0, y1: y };
		});
	});
}

/** Keeps every nth label so about `max` fit; always keeps the last one. */
export function thin<T>(labels: T[], max: number): (T | null)[] {
	const every = Math.max(1, Math.ceil(labels.length / Math.max(1, max)));
	return labels.map((l, i) => (i % every === 0 || i === labels.length - 1 ? l : null));
}
