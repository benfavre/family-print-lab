// Toolpath preview: how segments are coloured (the same colours as Bambu Studio's preview, so a plate
// looks familiar), the API's "still reading" answer, and small formatting helpers.
import type { PreviewData } from './slicer/preview';

export type ColourMode = 'feature' | 'filament' | 'speed';

/** GET /api/jobs/[id]/sliced/preview while a large plate is being read (HTTP 202). */
export interface PreviewPending {
	status: 'parsing';
	taskId: string;
}

// Bambu Studio's colours, BaseRenderer::Extrusion_Role_Colors, Travel_Colors[Move] and Wipe_Color
// (src/slic3r/GUI/GCodeRenderer/BaseRenderer.cpp ~118–197 at v02.08.02.61), as #rrggbb.
export const FEATURE_COLOURS: Record<string, string> = {
	Other: '#e6b3b3',
	Travel: '#38489b',
	'Outer wall': '#ff7d38',
	'Inner wall': '#ffe64d',
	'Overhang wall': '#1f1fff',
	'Sparse infill': '#b03029',
	'Internal solid infill': '#9654cc',
	'Top surface': '#f04040',
	'Bottom surface': '#665cc7',
	Bridge: '#4d80ba',
	'Gap infill': '#ffffff',
	Support: '#00ff00',
	'Support interface': '#008000',
	'Support transition': '#004000',
	Brim: '#003b6e',
	Skirt: '#00876e',
	'Prime tower': '#b3e3ab',
	Ironing: '#ff8c69',
	Custom: '#5ed194',
	Wipe: '#ffff00',
	'Floating vertical shell': '#e6b3b3',
	'Support ironing': '#99ff99',
	Multiple: '#e6b3b3',
	Flush: '#d9a6f2'
};

/** Bambu Studio's speed ramp, slow → fast (BaseRenderer::Range_Colors). */
export const SPEED_RAMP = [
	'#ff00ff',
	'#ff55a9',
	'#fe8778',
	'#ffb847',
	'#ffd925',
	'#ffff00',
	'#d8ff00',
	'#adff04',
	'#76ff01',
	'#00ff00'
];

export function hexRgb(hex: string): [number, number, number] {
	const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
	if (!m) return [136, 136, 136];
	const v = parseInt(m[1], 16);
	return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** The ramp colour at 0..1. */
export function rampRgb(t: number): [number, number, number] {
	const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (SPEED_RAMP.length - 1);
	const i = Math.min(SPEED_RAMP.length - 2, Math.floor(x));
	const a = hexRgb(SPEED_RAMP[i]),
		b = hexRgb(SPEED_RAMP[i + 1]);
	const f = x - i;
	return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number];
}

const isMove = (data: PreviewData, i: number) => {
	const name = data.header.features[data.attr[i * 4]];
	return name === 'Travel' || name === 'Wipe';
};

/** Slowest and fastest extrusion speeds (mm/s), for the speed legend. */
export function speedRange(data: PreviewData): [number, number] {
	let lo = Infinity,
		hi = -Infinity;
	for (let i = 0; i < data.header.segments; i++) {
		if (isMove(data, i)) continue;
		const v = data.speed[i];
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}
	return lo === Infinity ? [0, 0] : [lo, hi];
}

/**
 * Per-vertex RGBA (two vertices per segment) for a colour mode. Hidden feature codes get alpha 0 (the
 * renderer discards them), so toggling a feature only rewrites colours.
 */
export function segmentColours(
	data: PreviewData,
	mode: ColourMode,
	hidden: ReadonlySet<number>,
	out = new Uint8Array(data.header.segments * 8)
): Uint8Array {
	const byFeature = data.header.features.map((f) => hexRgb(FEATURE_COLOURS[f] ?? '#888888'));
	const byTool = new Map(data.header.tools.map((t) => [t.index, hexRgb(t.color)]));
	const grey = hexRgb('#888888');
	const [lo, hi] = mode === 'speed' ? speedRange(data) : [0, 0];
	const ramp = Array.from({ length: 64 }, (_, i) => rampRgb(i / 63));
	for (let i = 0; i < data.header.segments; i++) {
		const f = data.attr[i * 4];
		let c: [number, number, number];
		if (mode === 'feature' || isMove(data, i)) c = byFeature[f] ?? grey;
		else if (mode === 'filament') c = byTool.get(data.attr[i * 4 + 1]) ?? grey;
		else c = hi > lo ? ramp[Math.round(((data.speed[i] - lo) / (hi - lo)) * 63)] : ramp[63];
		const a = hidden.has(f) ? 0 : 255;
		const o = i * 8;
		out[o] = out[o + 4] = c[0];
		out[o + 1] = out[o + 5] = c[1];
		out[o + 2] = out[o + 6] = c[2];
		out[o + 3] = out[o + 7] = a;
	}
	return out;
}

/** Feature codes that occur in the preview, in code order, with their segment counts. */
export function featuresUsed(data: PreviewData): { code: number; name: string; count: number }[] {
	const counts = new Map<number, number>();
	for (let i = 0; i < data.header.segments; i++) {
		const f = data.attr[i * 4];
		counts.set(f, (counts.get(f) ?? 0) + 1);
	}
	return [...counts]
		.sort((a, b) => a[0] - b[0])
		.map(([code, count]) => ({ code, name: data.header.features[code] ?? 'Other', count }));
}

/** Seconds → "34 s", "5 min 20 s", "2 h 05 min". */
export function clock(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
	const s = Math.round(seconds);
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
	const m = Math.round(s / 60);
	return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
