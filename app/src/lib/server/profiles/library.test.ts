// The profile library against the fixture vendor folder (__fixtures__/README.md): loading and
// inheritance as upstream's PresetBundle does it, compatibility, defaults, user presets, diffs and the
// combined config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VendorError, VendorProfiles } from './vendor';
import { ProfileLibrary, mergeValue, nozzleVariant } from './library';
import type { PresetRef } from '$lib/shared/slicer/project';
import type { PresetKind, UserPreset } from '$lib/shared/slicer/profiles';
import { FIXTURE, memoryUsers } from './__fixtures__/helpers';

const X1C = 'Bambu Lab X1 Carbon 0.4 nozzle';

const library = (users = memoryUsers()) =>
	new ProfileLibrary(users, () => ({ dir: FIXTURE, source: 'env', tag: 'v02.08.02.61' }));
const sys = (kind: PresetKind, name: string): PresetRef => ({ kind, name, source: 'system' });

const temps: string[] = [];
afterEach(() => {
	for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('loading a vendor folder', () => {
	const v = VendorProfiles.load(FIXTURE);

	it('reads the version and the printer models with their nozzle variants', () => {
		expect(v.version).toBe('01.00.00.01');
		expect(v.models.get('Bambu Lab X1 Carbon')).toMatchObject({
			modelId: 'BL-P001',
			variants: ['0.4', '0.2'],
			defaultMaterials: ['Bambu PLA Basic @BBL X1C', 'Generic PLA']
		});
	});

	it('resolves inherits chains root last, and records which preset set each key', () => {
		const p = v.get('process', '0.20mm Standard @BBL X1C')!;
		expect(p.chain).toEqual(['0.20mm Standard @BBL X1C', 'fdm_process_common']);
		expect(p.config.sparse_infill_density).toBe('15%');
		expect(p.origin.sparse_infill_density).toBe('fdm_process_common');
		expect(p.config.inner_wall_speed).toEqual(['300', '400']);
		expect(p.origin.inner_wall_speed).toBe('0.20mm Standard @BBL X1C');
		// Metadata stays out of the config.
		for (const key of ['name', 'inherits', 'from', 'setting_id', 'instantiation', 'description'])
			expect(p.config).not.toHaveProperty(key);
		expect(p.settingId).toBe('GP004');
		expect(p.description).toBe('General purpose.');
	});

	it('applies includes after the parent and before the preset’s own keys', () => {
		const m = v.get('printer', X1C)!;
		expect(m.config.machine_start_gcode).toMatch(/^;===== machine: X1C/);
		expect(m.origin.machine_start_gcode).toBe(
			'Bambu Lab X1 Carbon 0.4 nozzle template machine_start_gcode'
		);
		// The 0.2 nozzle preset inherits the 0.4 one, include and all, and overrides retraction.
		const m2 = v.get('printer', 'Bambu Lab X1 Carbon 0.2 nozzle')!;
		expect(m2.config.machine_start_gcode).toBe(m.config.machine_start_gcode);
		expect(m2.config.retraction_length).toEqual(['0.4']);
		// A filament template include, with its "nil" slots kept for the slicer; own keys still win.
		const f = v.get('filament', 'Bambu PLA Basic @BBL X1C')!;
		expect(f.config.filament_extruder_variant).toEqual([
			'Direct Drive Standard',
			'Direct Drive High Flow'
		]);
		expect(f.config.filament_retraction_length).toEqual(['nil', '0.4']);
		expect(f.origin.filament_extruder_variant).toBe('fdm_filament_template_dual');
	});

	it('inherits filament_id and keeps bases and pure includes out of the selectable presets', () => {
		expect(v.get('filament', 'Bambu PLA Basic @BBL X1C')!.filamentId).toBe('GFA00');
		expect(v.get('filament', 'Bambu PLA Basic @base')!.instantiable).toBe(false);
		expect(v.all('filament').map((p) => p.name)).not.toContain('Bambu PLA Basic @base');
		expect(v.all('filament', true).map((p) => p.name)).toContain('Bambu PLA Basic @base');
		expect(v.get('printer', 'Bambu Lab X1 Carbon 0.4 nozzle template machine_start_gcode')).toBe(
			undefined
		);
	});

	it('drops printer presets whose variant the model does not list, as upstream does', () => {
		expect(v.get('printer', 'Bambu Lab X1 Carbon 0.6 nozzle')).toBe(undefined);
		expect(v.warnings.join('\n')).toMatch(/0\.6 nozzle/);
		expect(v.all('printer').map((p) => p.name)).toEqual([
			X1C,
			'Bambu Lab X1 Carbon 0.2 nozzle',
			'Bambu Lab A1 mini 0.4 nozzle'
		]);
	});

	function brokenCopy(edit: (dir: string) => void) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-vendor-'));
		temps.push(dir);
		fs.cpSync(FIXTURE, dir, { recursive: true });
		edit(dir);
		return dir;
	}

	it('fails on a missing parent or a filament without filament_id, like upstream', () => {
		const noParent = brokenCopy((dir) => {
			const f = path.join(dir, 'BBL/process/0.12mm Fine @BBL X1C.json');
			fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('fdm_process_common', 'nope'));
		});
		expect(() => VendorProfiles.load(noParent)).toThrow(/can not find inherits nope/);
		const noId = brokenCopy((dir) => {
			const f = path.join(dir, 'BBL/filament/Generic PLA.json');
			fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"filament_id": "GFL99",', ''));
		});
		expect(() => VendorProfiles.load(noId)).toThrow(VendorError);
		expect(() => VendorProfiles.load(path.join(os.tmpdir(), 'no-such-vendor'))).toThrow(
			VendorError
		);
	});
});

describe('compatibility', () => {
	const lib = library();

	it('lists presets for a printer by compatible_printers, or by condition when the list is empty', () => {
		const names = (kind: 'process' | 'filament', printer: string) =>
			lib.compatible(sys('printer', printer), kind).map((p) => p.name);
		expect(names('process', X1C)).toEqual(['0.20mm Standard @BBL X1C', '0.12mm Fine @BBL X1C']);
		expect(names('process', 'Bambu Lab A1 mini 0.4 nozzle')).toEqual([
			'0.20mm Standard @BBL A1M',
			'0.16mm Mini only @Test'
		]);
		// No list, no condition: compatible with every printer.
		expect(names('filament', 'Bambu Lab A1 mini 0.4 nozzle')).toEqual([
			'Bambu PLA Basic @BBL A1M',
			'Generic PLA'
		]);
	});

	it('treats a user printer preset like its system parent', () => {
		const users = memoryUsers([
			{
				id: 'u1',
				kind: 'printer',
				name: 'My X1C',
				inherits: X1C,
				config: { printable_height: '240' },
				updatedAt: ''
			}
		]);
		const l = library(users);
		const ref: PresetRef = { kind: 'printer', name: 'My X1C', source: 'user', userPresetId: 'u1' };
		expect(l.compatible(ref, 'process').map((p) => p.name)).toContain('0.20mm Standard @BBL X1C');
	});

	it('filters lists by model and nozzle', () => {
		expect(lib.list('printer', { model: 'BL-P001' }).map((p) => p.nozzle)).toEqual(['0.4', '0.2']);
		expect(lib.list('process', { model: 'BL-P001', nozzle: '0.2' }).map((p) => p.name)).toEqual([
			'0.10mm Standard @BBL X1C 0.2 nozzle'
		]);
		expect(lib.list('filament', { printer: X1C })[0]).toMatchObject({
			name: 'Bambu PLA Basic @BBL X1C',
			filamentId: 'GFA00',
			filamentType: 'PLA',
			settingId: 'GFSA00'
		});
		expect(lib.list('process', { includeHidden: true }).map((p) => p.name)).toContain(
			'fdm_process_common'
		);
	});

	it('finds the filament preset for an AMS tray by its filament id', () => {
		expect(lib.filamentForTray('GFA00', sys('printer', X1C))?.name).toBe(
			'Bambu PLA Basic @BBL X1C'
		);
		expect(lib.filamentForTray('GFA00', sys('printer', 'Bambu Lab A1 mini 0.4 nozzle'))?.name).toBe(
			'Bambu PLA Basic @BBL A1M'
		);
		expect(lib.filamentForTray('GFZZZ', sys('printer', X1C))).toBe(null);
	});
});

describe('defaults', () => {
	const lib = library();

	it('uses the printer preset’s default process and filament', () => {
		expect(lib.defaults('BL-P001', '0.4')).toEqual({
			printer: sys('printer', X1C),
			process: sys('process', '0.20mm Standard @BBL X1C'),
			filaments: [sys('filament', 'Bambu PLA Basic @BBL X1C')]
		});
		expect(lib.defaults('BL-P001', '0.20').process.name).toBe(
			'0.10mm Standard @BBL X1C 0.2 nozzle'
		);
		expect(lib.defaults('N1', '0.4').filaments[0].name).toBe('Bambu PLA Basic @BBL A1M');
	});

	it('picks the closest Bambu filament for a material', () => {
		expect(lib.defaults('BL-P001', '0.4', 'PETG HF').filaments[0].name).toBe(
			'Bambu PETG HF @BBL X1C'
		);
		expect(lib.defaults('BL-P001', '0.4', 'PLA Matte').filaments[0].name).toBe(
			'Bambu PLA Matte @BBL X1C'
		);
		expect(lib.defaults('BL-P001', '0.4', 'PLA').filaments[0].name).toBe(
			'Bambu PLA Basic @BBL X1C'
		);
	});

	it('says plainly when a nozzle or model has no preset', () => {
		expect(() => lib.defaults('BL-P001', '0.8')).toThrow(/no 0.8 mm nozzle preset for the X1C/);
		expect(() => lib.defaults('N6', '0.4')).toThrow(/X2D/);
		expect(() => lib.defaults('BL-P001', '0.4', 'ABS')).toThrow(/no ABS filament preset/);
	});

	it('picks a process by layer height, Standard first', () => {
		const list = lib.compatible(sys('printer', X1C), 'process');
		expect(lib.pickProcess(list, 0.12)?.name).toBe('0.12mm Fine @BBL X1C');
		expect(lib.pickProcess(list, 0.28)?.name).toBe('0.20mm Standard @BBL X1C');
	});

	it('normalises nozzle sizes', () => {
		expect(nozzleVariant('0.40')).toBe('0.4');
		expect(nozzleVariant(0.2)).toBe('0.2');
		expect(nozzleVariant('')).toBe('0.4');
	});
});

describe('user presets', () => {
	const users = memoryUsers();
	const lib = library(users);
	const add = (u: Omit<UserPreset, 'updatedAt'>) => users.list_.push({ ...u, updatedAt: '' });

	it('stores only what differs from the system parent, keeping it on "Save as" from a user preset', () => {
		const d = lib.derive('process', 'Strong', sys('process', '0.20mm Standard @BBL X1C'), {
			sparse_infill_density: '40%',
			wall_loops: '2' // same as the parent: not stored
		});
		expect(d).toEqual({
			inherits: '0.20mm Standard @BBL X1C',
			config: { sparse_infill_density: '40%' }
		});
		add({ id: 'p1', kind: 'process', name: 'Strong', ...d });
		const again = lib.derive(
			'process',
			'Stronger',
			{ kind: 'process', name: 'Strong', source: 'user', userPresetId: 'p1' },
			{ wall_loops: '4' }
		);
		expect(again).toEqual({
			inherits: '0.20mm Standard @BBL X1C',
			config: { sparse_infill_density: '40%', wall_loops: '4' }
		});
		expect(() => lib.derive('process', '0.12mm Fine @BBL X1C', null, {})).toThrow(/system preset/);
		expect(() => lib.derive('process', 'x', sys('process', 'fdm_process_common'), {})).toThrow(
			/base preset/
		);
	});

	it('resolves over the parent, "nil" slots taking the parent’s value', () => {
		add({
			id: 'f1',
			kind: 'filament',
			name: 'Hot PLA',
			inherits: 'Bambu PLA Basic @BBL X1C',
			config: { nozzle_temperature: ['nil', '235'] }
		});
		const r = lib.resolve({
			kind: 'filament',
			name: 'Hot PLA',
			source: 'user',
			userPresetId: 'f1'
		});
		expect(r.config.nozzle_temperature).toEqual(['220', '235']);
		expect(r.origin.nozzle_temperature).toBe('Hot PLA');
		expect(r.chain[0]).toBe('Hot PLA');
		expect(r.chain[1]).toBe('Bambu PLA Basic @BBL X1C');
		expect(mergeValue('a', 'b')).toBe('b');
	});

	it('diffs a user preset overriding sparse_infill_density against its parent', () => {
		const ref: PresetRef = { kind: 'process', name: 'Strong', source: 'user', userPresetId: 'p1' };
		expect(lib.diff(ref)).toEqual([{ key: 'sparse_infill_density', value: '40%', parent: '15%' }]);
		// A system preset diffs its own file against its parent.
		expect(lib.diff(sys('process', '0.20mm Standard @BBL X1C'))).toEqual([
			{ key: 'compatible_printers', value: [X1C], parent: null },
			{ key: 'inner_wall_speed', value: ['300', '400'], parent: ['300', '300'] }
		]);
		const pages = lib.pages(ref);
		const all = pages.flatMap((p) => p.groups.flatMap((g) => g.keys));
		expect(all.find((k) => k.key === 'sparse_infill_density')).toMatchObject({
			changed: true,
			value: '40%',
			parent: '15%',
			origin: 'Strong'
		});
		// Grouped like Bambu Studio's tabs.
		const strength = pages.find((p) => p.page === 'Strength')!;
		expect(
			strength.groups.find((g) => g.group === 'Sparse infill')?.keys.map((k) => k.key)
		).toContain('sparse_infill_density');
	});

	it('combines a selection into the flat config the slicer reads', () => {
		const b = lib.bundle(
			{
				printer: sys('printer', X1C),
				process: { kind: 'process', name: 'Strong', source: 'user', userPresetId: 'p1' },
				filaments: [sys('filament', 'Bambu PLA Basic @BBL X1C')]
			},
			{ process: { wall_loops: '5' } }
		);
		expect(b.full.sparse_infill_density).toBe('40%');
		expect(b.full.wall_loops).toBe('5');
		expect(b.process.origin.wall_loops).toBe('override');
		expect(b.full.machine_start_gcode).toMatch(/machine: X1C/);
		expect(b.full.print_settings_id).toBe('Strong');
		expect(b.full.printer_settings_id).toBe(X1C);
		expect(b.full.filament_settings_id).toEqual(['Bambu PLA Basic @BBL X1C']);
		expect(b.full.filament_ids).toEqual(['GFA00']);
		expect(b.full.inherits_group).toEqual(['0.20mm Standard @BBL X1C', '', '']);
		expect(b.full.different_settings_to_system).toEqual([
			'sparse_infill_density;wall_loops',
			'',
			''
		]);
		expect(b.full).not.toHaveProperty('compatible_printers');
		expect(b.vendor).toEqual({ tag: 'v02.08.02.61', version: '01.00.00.01' });
	});

	it('merges several filaments key by key: vectors appended, scalars from the first', () => {
		const b = lib.bundle({
			printer: sys('printer', X1C),
			process: sys('process', '0.20mm Standard @BBL X1C'),
			filaments: [
				sys('filament', 'Bambu PLA Matte @BBL X1C'),
				sys('filament', 'Bambu PETG HF @BBL X1C')
			]
		});
		expect(b.full.filament_type).toEqual(['PLA', 'PETG']);
		expect(b.full.nozzle_temperature).toEqual(['220', '250']);
		expect(b.full.filament_ids).toEqual(['GFA01', 'GFG02']);
		expect(b.full).not.toHaveProperty('inherits_group');
		expect(b.full).not.toHaveProperty('different_settings_to_system');
	});

	it('reports a user preset whose parent is gone', () => {
		add({ id: 'x', kind: 'process', name: 'Orphan', inherits: 'Gone', config: {} });
		expect(() =>
			lib.resolve({ kind: 'process', name: 'Orphan', source: 'user', userPresetId: 'x' })
		).toThrow(/do not have/);
		// Listing still shows it.
		expect(lib.list('process').map((p) => p.name)).toContain('Orphan');
	});
});

describe('without system presets', () => {
	it('says how to get them', () => {
		const lib = new ProfileLibrary(memoryUsers(), () => null);
		expect(lib.vendor()).toBe(null);
		expect(lib.missing()).toMatch(/profiles:fetch/);
		expect(lib.list('process')).toEqual([]);
		expect(() => lib.defaults('BL-P001', '0.4')).toThrow(/profiles:fetch/);
	});
});
