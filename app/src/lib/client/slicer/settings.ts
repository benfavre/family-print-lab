// Per-object, per-part and per-height-range settings the workspace offers, grouped like Bambu Studio's
// object settings (its "Add settings" menu uses the process tabs: Quality, Strength, Speed, Support,
// Others; src/slic3r/GUI/Tab.cpp, as in server/profiles/groups.generated.ts, which a test checks these
// keys against). Values are text as upstream stores them; the placeholder shows what the presets give.
// Hints list the option values of src/libslic3r/PrintConfig.cpp (s_keys_map_SeamPosition, _SupportType,
// _BrimType, _IroningType, _FuzzySkinType, _InfillPattern) at the tag in slicer/upstream.lock.
import type { ConfigMap, ConfigValue } from '$lib/shared/slicer/project';

export interface SettingDef {
	key: string;
	label: string;
	/** 'bool': Bambu's "0"/"1"; 'text': anything else (with a hint). */
	kind: 'bool' | 'text';
	hint?: string;
}
export interface SettingGroup {
	/** The Bambu Studio page it sits on. */
	page: 'Quality' | 'Strength' | 'Speed' | 'Support' | 'Others';
	settings: SettingDef[];
}

const text = (key: string, label: string, hint: string): SettingDef => ({
	key,
	label,
	kind: 'text',
	hint
});
const bool = (key: string, label: string): SettingDef => ({ key, label, kind: 'bool' });

export const OBJECT_SETTINGS: SettingGroup[] = [
	{
		page: 'Quality',
		settings: [
			text('layer_height', 'Layer height', 'mm, e.g. 0.16'),
			text('seam_position', 'Seam', 'aligned, nearest, back, random'),
			text('ironing_type', 'Ironing', 'no ironing, top, topmost, solid'),
			bool('detect_thin_wall', 'Detect thin walls')
		]
	},
	{
		page: 'Strength',
		settings: [
			text('wall_loops', 'Wall loops', 'e.g. 3'),
			text('top_shell_layers', 'Top shell layers', 'e.g. 5'),
			text('bottom_shell_layers', 'Bottom shell layers', 'e.g. 3'),
			text('sparse_infill_density', 'Infill density', 'e.g. 20%'),
			text('sparse_infill_pattern', 'Infill pattern', 'e.g. gyroid, grid, cubic'),
			text('infill_direction', 'Infill direction', 'degrees, e.g. 45')
		]
	},
	{
		page: 'Speed',
		settings: [
			text('outer_wall_speed', 'Outer wall speed', 'mm/s'),
			text('sparse_infill_speed', 'Infill speed', 'mm/s')
		]
	},
	{
		page: 'Support',
		settings: [
			bool('enable_support', 'Supports'),
			text(
				'support_type',
				'Support type',
				'normal(auto), tree(auto), normal(manual), tree(manual)'
			),
			text('support_threshold_angle', 'Overhang angle', 'degrees, e.g. 30'),
			bool('support_on_build_plate_only', 'On build plate only'),
			text('brim_type', 'Brim', 'auto_brim, outer_only, no_brim'),
			text('brim_width', 'Brim width', 'mm')
		]
	},
	{
		page: 'Others',
		settings: [
			text('fuzzy_skin', 'Fuzzy skin', 'none, external, all'),
			text('fuzzy_skin_thickness', 'Fuzzy skin thickness', 'mm'),
			text('fuzzy_skin_point_distance', 'Fuzzy skin point distance', 'mm')
		]
	}
];

/** Keys a modifier or height range usually changes (a shorter list for small panels). */
export const RANGE_KEYS = [
	'sparse_infill_density',
	'sparse_infill_pattern',
	'wall_loops',
	'layer_height',
	'top_shell_layers'
];

const ALL = new Map(OBJECT_SETTINGS.flatMap((g) => g.settings.map((s) => [s.key, s])));

export const settingDef = (key: string): SettingDef =>
	ALL.get(key) ?? { key, label: key.replace(/_/g, ' '), kind: 'text' };

/** Settings in a config map, grouped by page, known ones first then the rest (raw keys) under Others. */
export function groupConfig(config: ConfigMap): { page: string; keys: SettingDef[] }[] {
	const groups: { page: string; keys: SettingDef[] }[] = [];
	for (const g of OBJECT_SETTINGS) {
		const keys = g.settings.filter((s) => s.key in config);
		if (keys.length) groups.push({ page: g.page, keys });
	}
	const unknown = Object.keys(config)
		.filter((k) => !ALL.has(k) && k !== 'extruder')
		.sort()
		.map(settingDef);
	if (unknown.length) {
		const others = groups.find((g) => g.page === 'Others');
		if (others) others.keys.push(...unknown);
		else groups.push({ page: 'Others', keys: unknown });
	}
	return groups;
}

/** Settings not set yet, for the "Add setting" picker. */
export function addableSettings(config: ConfigMap): SettingGroup[] {
	return OBJECT_SETTINGS.map((g) => ({
		...g,
		settings: g.settings.filter((s) => !(s.key in config))
	})).filter((g) => g.settings.length);
}

/** A config value as one line of text. */
export const valueText = (v: ConfigValue | undefined) =>
	v === undefined ? '' : Array.isArray(v) ? v.join(', ') : v;

/** Setting names as Bambu Studio writes them (a raw key someone types in). */
export const isSettingKey = (key: string) => /^[a-z][a-z0-9_]{0,99}$/.test(key);
