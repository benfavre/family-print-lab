// Checks against the real Bambu Studio vendor set, when one is on this machine (bun run
// profiles:fetch, PRINTLAB_PROFILES_DIR, or an installed Bambu Studio); skipped otherwise. And the
// oracle comparison with the engine's own PresetBundle, when a Print Lab Slicer engine is present.
import { afterAll, describe, expect, it } from 'vitest';
import { locateProfiles } from './locate';
import { ProfileLibrary } from './library';
import { parseCondition } from './condition';
import { memoryUsers } from './__fixtures__/helpers';
import { openSlicer } from '../slicer/engine';
import { locateEngine } from '../slicer/locate';
import { MODEL_CODES, PRINTER_MODELS } from '$lib/shared/printers/models';
import type { PresetSelection } from '$lib/shared/slicer/project';

const where = locateProfiles();
const users = memoryUsers();
const lib = new ProfileLibrary(users, () => where);
const set = where ? lib.vendorSet() : null;

describe.skipIf(!where)('the Bambu Studio vendor set on this machine', () => {
	it('loads without errors', () => {
		expect(lib.missing()).toBe(null);
		expect(set!.all('printer').length).toBeGreaterThan(10);
		expect(set!.all('process').length).toBeGreaterThan(50);
		expect(set!.all('filament').length).toBeGreaterThan(100);
	});

	it('parses every compatible_printers_condition and compatible_prints_condition in it', () => {
		for (const c of set!.conditions()) expect(() => parseCondition(c), c).not.toThrow();
	});

	it('resolves a default selection for each catalogue model it has presets for', () => {
		let covered = 0;
		for (const code of MODEL_CODES) {
			const m = PRINTER_MODELS[code];
			const entry = set!.models.get(m.name);
			if (!entry) continue;
			const nozzle = entry.variants.includes('0.4') ? '0.4' : entry.variants[0];
			const sel = lib.defaults(code, nozzle);
			const b = lib.bundle(sel);
			expect(b.full.printer_model, code).toBe(m.name);
			expect(b.full.layer_height, code).toBeTruthy();
			expect(b.full.filament_ids, code).toEqual([expect.stringMatching(/^G/)]);
			covered++;
		}
		expect(covered).toBeGreaterThanOrEqual(10);
	});

	it('gives every selectable filament a filament_id and every preset a resolvable chain', () => {
		for (const f of set!.all('filament')) expect(f.filamentId, f.name).toBeTruthy();
		for (const kind of ['printer', 'process', 'filament'] as const)
			for (const p of set!.all(kind)) expect(p.chain.at(-1), p.name).toMatch(/common|fdm/);
	});

	it('flows a user preset overriding sparse_infill_density into the combined config', () => {
		const sel = lib.defaults('BL-P001', '0.4');
		const d = lib.derive('process', 'My strong X1C', sel.process, { sparse_infill_density: '45%' });
		users.list_.push({ id: 'u', kind: 'process', name: 'My strong X1C', ...d, updatedAt: '' });
		const ref = {
			kind: 'process' as const,
			name: 'My strong X1C',
			source: 'user' as const,
			userPresetId: 'u'
		};
		expect(lib.diff(ref)).toEqual([
			{ key: 'sparse_infill_density', value: '45%', parent: expect.any(String) }
		]);
		const b = lib.bundle({ ...sel, process: ref });
		expect(b.full.sparse_infill_density).toBe('45%');
		expect(b.full.different_settings_to_system).toEqual(['sparse_infill_density', '', '']);
	});
});

// Compare values using the types declared in Bambu Studio v02.08.02.61
// src/libslic3r/PrintConfig.cpp. Config.hpp's scalar serializers canonicalise decimal/percent
// spelling and ConfigOptionPoint accepts both separators. Config.cpp::load_from_json flattens
// singleton arrays before set_deserialize, including the X1's scalar retraction setting.
// Keep this list explicit: G-code and arbitrary string options must still match byte for byte.
const oracleTypes: Record<string, 'float' | 'percent' | 'int'> = {
	top_surface_density: 'percent',
	bottom_surface_density: 'percent',
	monotonic_travel_into_wall: 'percent',
	infill_lock_depth: 'float',
	skin_infill_depth: 'float',
	support_ironing_inset: 'float',
	top_shell_thickness: 'float',
	fuzzy_skin_scale: 'float',
	enable_long_retraction_when_cut: 'int'
};
function oracleValue(key: string, value: unknown): unknown {
	if (key === 'best_object_pos' && typeof value === 'string') {
		const point = value.split(/[x,]/);
		if (point.length === 2 && point.every((v) => v.trim() && Number.isFinite(Number(v))))
			return point.map(Number);
	}
	const kind = oracleTypes[key];
	if (kind === 'int' && Array.isArray(value) && value.length === 1) value = value[0];
	if (kind && typeof value === 'string') {
		const number = kind === 'percent' ? value.replace(/%$/, '') : value;
		if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(number) && Number.isFinite(Number(number)))
			return Number(number);
	}
	return value;
}

describe('typed preset oracle comparison', () => {
	it('accepts equivalent point, decimal, percent and singleton scalar spellings', () => {
		for (const [key, left, right] of [
			['best_object_pos', '0.5x0.5', '0.5,0.5'],
			['infill_lock_depth', '1.0', '1'],
			['bottom_surface_density', '100', '100%'],
			['enable_long_retraction_when_cut', ['2'], '2']
		] as const)
			expect(oracleValue(key, left)).toEqual(oracleValue(key, right));
	});
	it('keeps G-code, arbitrary strings and invalid typed values exact', () => {
		for (const [key, value] of [
			['machine_start_gcode', 'G28\nG1 X20'],
			['machine_start_gcode', 'G28\\nG1 X20'],
			['printer_model', '1.0'],
			['infill_lock_depth', '1%'],
			['bottom_surface_density', 'unknown'],
			['enable_long_retraction_when_cut', ['1', '2']]
		] as const)
			expect(oracleValue(key, value)).toEqual(value);
	});
	it('still detects changed numeric values', () => {
		expect(oracleValue('best_object_pos', '0.5x0.5')).not.toEqual(
			oracleValue('best_object_pos', '0.5,0.6')
		);
		expect(oracleValue('bottom_surface_density', '90')).not.toEqual(
			oracleValue('bottom_surface_density', '100%')
		);
	});
});

// The engine's PresetBundle is the oracle: compare a sample of selections key by key.
const engineHere = !!locateEngine();
describe.skipIf(!engineHere || !where)('oracle: the engine’s own preset resolution', () => {
	afterAll(async () => (await openSlicer())?.close());

	it('agrees with resolve() for a sample of presets', async () => {
		const engine = await openSlicer();
		if (!engine?.has('profiles.resolve')) return expect(engine).toBeTruthy();
		const samples: PresetSelection[] = MODEL_CODES.filter((c) =>
			set!.models.has(PRINTER_MODELS[c].name)
		)
			.slice(0, 5)
			.map((c) => lib.defaults(c, '0.4'));
		for (const selection of samples) {
			const ours = lib.bundle(selection);
			const theirs = await engine.call('profiles.resolve', { selection, vendorDir: where!.dir });
			for (const part of ['printer', 'process'] as const)
				for (const [key, value] of Object.entries(ours[part].config))
					if (key in theirs[part].config)
						expect(
							oracleValue(key, theirs[part].config[key]),
							`${ours[part].name}: ${key}`
						).toEqual(oracleValue(key, value));
		}
	});
});
