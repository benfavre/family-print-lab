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
						expect(theirs[part].config[key], `${ours[part].name}: ${key}`).toEqual(value);
		}
	});
});
