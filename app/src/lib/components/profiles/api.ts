// Small helpers the slicer profile components share.
import type { ConfigValue, PresetRef } from '$lib/shared/slicer/project';
import type { PresetSummary } from '$lib/shared/slicer/profiles';

/** GETs JSON; returns the data or the server's error in plain words. */
export async function getJson<T>(url: string): Promise<{ data: T | null; error: string | null }> {
	try {
		const r = await fetch(url);
		const body = await r.json().catch(() => ({}));
		return r.ok
			? { data: body as T, error: null }
			: { data: null, error: body.error ?? `Request failed (${r.status}).` };
	} catch {
		return { data: null, error: 'Could not reach the app server.' };
	}
}

export const query = (params: Record<string, string | undefined | null>) =>
	new URLSearchParams(
		Object.entries(params).filter((e): e is [string, string] => !!e[1])
	).toString();

/** A summary as a reference the API takes. */
export const refOf = (s: PresetSummary): PresetRef =>
	s.source === 'user'
		? { kind: s.kind, name: s.name, source: 'user', userPresetId: s.id }
		: { kind: s.kind, name: s.name, source: 'system' };

export const sameRef = (a: PresetRef | null | undefined, b: PresetRef | null | undefined) =>
	!!a &&
	!!b &&
	a.kind === b.kind &&
	a.source === b.source &&
	(a.source === 'user'
		? a.userPresetId === b.userPresetId || a.name === b.name
		: a.name === b.name);

/** The URL of one preset's detail. */
export const detailUrl = (r: PresetRef) =>
	r.source === 'user' && r.userPresetId
		? `/api/slicer/presets/${r.userPresetId}`
		: `/api/slicer/profiles/preset?${query({ kind: r.kind, name: r.name, source: r.source })}`;

/** A preset name without Bambu's " @BBL X1C" suffix. */
export const shortName = (name: string) => name.replace(/\s*@.*$/, '') || name;

export const showValue = (v: ConfigValue | null | undefined) =>
	v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') : v;

/** Settings people change most, for the per-job override picker. */
export const COMMON_KEYS: { key: string; label: string; hint: string }[] = [
	{ key: 'sparse_infill_density', label: 'Infill density', hint: 'e.g. 20%' },
	{ key: 'wall_loops', label: 'Wall loops', hint: 'e.g. 3' },
	{ key: 'top_shell_layers', label: 'Top shell layers', hint: 'e.g. 5' },
	{ key: 'bottom_shell_layers', label: 'Bottom shell layers', hint: 'e.g. 3' },
	{ key: 'layer_height', label: 'Layer height', hint: 'e.g. 0.16' },
	{ key: 'sparse_infill_pattern', label: 'Infill pattern', hint: 'e.g. gyroid' },
	{ key: 'brim_type', label: 'Brim', hint: 'auto_brim, outer_only, no_brim' },
	{ key: 'enable_support', label: 'Supports', hint: '1 on, 0 off' },
	{ key: 'seam_position', label: 'Seam', hint: 'aligned, back, random' },
	{ key: 'ironing_type', label: 'Ironing', hint: 'no ironing, top, topmost' }
];
