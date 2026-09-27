import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODEL_CODES, PRINTER_MODELS } from '$lib/shared/printers/models';
import { ERROR } from '$lib/shared/slicer/protocol';
import { IDENTITY, emptyProject, type Transform } from '$lib/shared/slicer/project';
import { readSliced } from '../printer/sliced';
import { readZip, writeStl, writeZip } from '../cad/mesh';
import {
	CliEngine,
	bake,
	cliArgs,
	compose,
	finishSliced,
	parseResult,
	plateOrigin,
	readPlacements,
	splitOverrides,
	versionFromPath
} from './cli';
import { machinePreset, selectionOf } from './profile-book';
import { sliceModel, type SliceSettings } from './service';
import { fakeInstall, type FakeInstall } from './__fixtures__/install';

/** Transforms equal to float precision. */
function near(actual: Transform, expected: Transform) {
	expect(actual).toHaveLength(12);
	actual.forEach((v, i) => expect(v, `number ${i}`).toBeCloseTo(expected[i], 3));
}

/** A 20 × 20 × 10 mm box as a triangle soup. */
function box(w = 20, d = 20, h = 10): Float32Array {
	const v = [
		[0, 0, 0],
		[w, 0, 0],
		[w, d, 0],
		[0, d, 0],
		[0, 0, h],
		[w, 0, h],
		[w, d, h],
		[0, d, h]
	];
	const f = [
		[0, 2, 1],
		[0, 3, 2],
		[4, 5, 6],
		[4, 6, 7],
		[0, 1, 5],
		[0, 5, 4],
		[1, 2, 6],
		[1, 6, 5],
		[2, 3, 7],
		[2, 7, 6],
		[3, 0, 4],
		[3, 4, 7]
	];
	return new Float32Array(f.flatMap((t) => t.flatMap((i) => v[i])));
}

describe('command line arguments', () => {
	const base = {
		machine: 'machine.json',
		process: 'process.json',
		filaments: ['filament_1.json'],
		bedType: 'Textured PEI Plate',
		inputs: ['object 1.stl'],
		filamentIds: [1],
		output: 'result.3mf'
	};

	it('slices one object with complete presets', () => {
		expect(cliArgs({ ...base, slice: 1 })).toEqual([
			'--load-settings',
			'machine.json;process.json',
			'--load-filaments',
			'filament_1.json',
			'--curr-bed-type',
			'Textured PEI Plate',
			'--slice',
			'1',
			'--outputdir',
			'out',
			'--export-3mf',
			'result.3mf',
			'object 1.stl'
		]);
	});

	it('gives each input its filament, and orients or arranges on request', () => {
		const args = cliArgs({
			...base,
			filaments: ['filament_1.json', 'filament_2.json'],
			inputs: ['object 1.stl', 'object 2.stl'],
			filamentIds: [1, 2],
			orient: true,
			arrange: true,
			allowRotations: false
		});
		expect(args.join(' ')).toContain(
			'--load-filaments filament_1.json;filament_2.json --curr-bed-type Textured PEI Plate --load-filament-ids 1,2 --orient 1 --arrange 1 --allow-rotations=0'
		);
		expect(args).not.toContain('--slice');
		expect(args.slice(-2)).toEqual(['object 1.stl', 'object 2.stl']);
		// Positions kept on request: STL inputs are arranged otherwise.
		expect(cliArgs({ ...base, slice: 1, arrange: false }).join(' ')).toContain(
			'--arrange 0 --slice 1'
		);
	});

	it('never passes an input that looks like an option', () => {
		expect(() => cliArgs({ ...base, inputs: ['-x.stl'] })).toThrow('looks like an option');
	});

	it.each(MODEL_CODES)('names the machine preset for %s the way Bambu Studio does', (code) => {
		expect(machinePreset(code, '0.4')).toBe(`${PRINTER_MODELS[code].name} 0.4 nozzle`);
		expect(machinePreset(code, '')).toBe(`${PRINTER_MODELS[code].name} 0.4 nozzle`);
	});

	it('reads the version from an unpacked install', () => {
		expect(versionFromPath('/home/me/.local/opt/bambu-studio-02.08.02.61/AppRun')).toBe(
			'02.08.02.61'
		);
		expect(versionFromPath('/usr/bin/bambu-studio')).toBeNull();
	});
});

describe('reading what the command line wrote', () => {
	it('parses result.json', () => {
		expect(
			parseResult({
				plate_index: 0,
				return_code: 0,
				error_string: 'Success.',
				sliced_plates: [
					{
						id: 1,
						total_predication: 1234.6,
						warning_message: '',
						filaments: [{ id: 0, filament_id: 'GFA00', total_used_g: 4.256 }]
					}
				]
			})
		).toEqual({
			ok: true,
			error: 'Success.',
			plates: [{ id: 1, seconds: 1235, grams: [4.26], warning: '' }]
		});
		expect(parseResult({ return_code: -50, error_string: 'Nothing to be sliced' })).toMatchObject({
			ok: false,
			error: 'Nothing to be sliced',
			plates: []
		});
		expect(parseResult(null).ok).toBe(false);
	});

	it('reads where each object ended up: its component (the volume), then its build item', () => {
		const model = `<model><resources>
  <object id="2" p:UUID="00010000" type="model">
   <components>
    <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 0 1 0 -1 0 0 0 10"/>
   </components>
  </object>
  <object id="4" type="model"><mesh/></object>
 </resources><build p:UUID="x">
  <item objectid="2" p:UUID="0002" transform="1 0 0 0 1 0 0 0 1 128 128 5" printable="1"/>
  <item objectid="4" transform="0 1 0 -1 0 0 0 0 1 10 20 0" printable="1"/>
  <item objectid="6" printable="1"/>
 </build></model>`;
		const file = writeZip([['3D/3dmodel.model', Buffer.from(model)]]);
		expect(readPlacements(file)).toEqual([
			// Turned about X by the volume, lifted 10 by it, then moved by the item.
			[1, 0, 0, 0, 0, 1, 0, -1, 0, 128, 128, 15],
			[0, 1, 0, -1, 0, 0, 0, 0, 1, 10, 20, 0],
			[...IDENTITY]
		]);
	});

	it('lays plates out in Bambu Studio’s grid', () => {
		const bed = ['0x0', '256x0', '256x256', '0x256'];
		expect(plateOrigin(bed, 1, 1)).toEqual([0, 0]);
		expect(plateOrigin(bed, 2, 2)[0]).toBeCloseTo(307.2);
		// Four plates: two columns, so plate 3 starts the second row (rows go towards -y).
		expect(plateOrigin(bed, 4, 3)).toEqual([0, -307.2]);
		expect(plateOrigin(bed, 4, 4)[0]).toBeCloseTo(307.2);
		// Five plates: three columns.
		expect(plateOrigin(bed, 5, 3)[0]).toBeCloseTo(614.4);
		expect(plateOrigin(['0x0', '180x0', '180x180', '0x180'], 2, 2)[0]).toBeCloseTo(216);
		expect(plateOrigin(undefined, 1, 1)).toEqual([0, 0]);
	});

	it('composes transforms: the first one applies first', () => {
		const rotate: Transform = [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0]; // x → y
		const move: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0];
		// (1,0,0) rotated is (0,1,0), then moved: (10,1,0).
		const t = compose(rotate, move);
		const p = bake(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0]), t);
		expect([...p.slice(0, 3)]).toEqual([10, 1, 0]);
		expect(compose(IDENTITY, move)).toEqual(move);
	});

	it('keeps facets facing outwards when a transform mirrors', () => {
		const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		const mirrored = bake(tri, [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
		// Vertices 2 and 3 swap, so the winding (and the normal) stay as they were.
		expect([...mirrored].map((v) => v + 0)).toEqual([0, 0, 0, 0, 1, 0, -1, 0, 0]);
	});

	it('puts project overrides in the preset that owns the key', () => {
		const preset = (config: Record<string, string | string[]>) => ({
			kind: 'process' as const,
			name: 'x',
			chain: ['x'],
			config,
			origin: {}
		});
		const split = splitOverrides(
			{
				printer: { ...preset({ nozzle_diameter: ['0.4'] }), kind: 'printer' },
				process: preset({ wall_loops: '2' }),
				filaments: [
					{ ...preset({ filament_colour: ['#FFFFFF'] }), kind: 'filament' },
					{ ...preset({ filament_colour: ['#FFFFFF'] }), kind: 'filament' }
				],
				full: {},
				vendor: { tag: 'v1', version: '1' }
			},
			{
				wall_loops: '3',
				nozzle_diameter: ['0.6'],
				filament_colour: ['#FF0000', '#00FF00'],
				brand_new_key: '1'
			}
		);
		expect(split).toEqual({
			printer: { nozzle_diameter: ['0.6'] },
			process: { wall_loops: '3', brand_new_key: '1' },
			filaments: [{ filament_colour: ['#FF0000'] }, { filament_colour: ['#00FF00'] }]
		});
	});

	it('fills in the printer model code and plate pictures the command line leaves out', () => {
		const png = Buffer.from('89504e470d0a1a0a', 'hex');
		const file = writeZip([
			['Metadata/plate_1.gcode', Buffer.from('G28\n')],
			['Metadata/plate_1.gcode.md5', Buffer.from('ABC')],
			[
				'Metadata/slice_info.config',
				Buffer.from('<plate><metadata key="printer_model_id" value=""/></plate>')
			]
		]);
		const out = readZip(finishSliced(file, 'C12', new Map([[1, png]])), () => 'all');
		expect(out.get('Metadata/slice_info.config')!.toString()).toContain(
			'<metadata key="printer_model_id" value="C12"/>'
		);
		expect(out.get('Metadata/plate_1.png')!.equals(png)).toBe(true);
		expect(out.get('Metadata/plate_no_light_1.png')!.equals(png)).toBe(true);
		expect(out.get('Metadata/plate_1.gcode')!.toString()).toBe('G28\n');
	});
});

describe('CliEngine against a fake Bambu Studio', () => {
	let install: FakeInstall;
	let work: string;
	const engines: CliEngine[] = [];
	const open = (env: Record<string, string> = {}) => {
		const e = new CliEngine({
			location: {
				kind: 'bambu-studio-cli',
				path: install.bin,
				resourcesDir: install.resources,
				source: 'installed'
			},
			workDir: fs.mkdtempSync(path.join(work, 'cli-')),
			env: { FAKE_CLI_LOG: install.log, ...env }
		});
		engines.push(e);
		return e;
	};
	const settings = (
		model: SliceSettings['model'],
		o: Partial<SliceSettings> = {}
	): SliceSettings => ({
		model,
		nozzle: '0.4',
		layerHeight: '0.20',
		material: 'PLA',
		supports: 'None',
		infill: 15,
		plate: 'Textured PEI',
		...o
	});

	beforeAll(() => {
		install = fakeInstall();
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-cli-'));
	});
	afterAll(async () => {
		await Promise.all(engines.map((e) => e.close()));
		install.remove();
		fs.rmSync(work, { recursive: true, force: true });
	});

	it('describes itself as the command line backend', () => {
		const e = open();
		expect(e.info).toMatchObject({
			engine: 'bambu-studio-cli',
			version: '02.08.02.61',
			protocol: { major: 1 },
			upstream: { name: 'BambuStudio', tag: 'v02.08.02.61', commit: null },
			patchQueue: null,
			profiles: {
				dir: path.join(install.resources, 'profiles', 'BBL'),
				vendorVersion: '02.08.00.05'
			}
		});
		expect(e.has('slice')).toBe(true);
		expect(e.has('preview.v1')).toBe(false);
	});

	it('resolves presets through their parents, remembering who set each key', async () => {
		const e = open();
		const bundle = await e.call('profiles.resolve', {
			selection: selectionOf({
				machine: 'Bambu Lab P1S 0.4 nozzle',
				process: '0.20mm Standard @BBL P1S',
				filament: 'Bambu PLA Basic @BBL P1S'
			})
		});
		expect(bundle.printer.chain).toEqual(['Bambu Lab P1S 0.4 nozzle', 'fdm_machine_common']);
		expect(bundle.filaments[0].config).toMatchObject({
			filament_id: 'GFA00',
			filament_type: ['PLA']
		});
		expect(bundle.filaments[0].origin.filament_type).toBe('Bambu PLA Basic @base');
		expect(bundle.full.filament_type).toEqual(['PLA']);
		expect(bundle.full.layer_height).toBe('0.2');
		expect(bundle.vendor).toEqual({ tag: 'v02.08.02.61', version: '02.08.00.05' });
		await expect(
			e.call('profiles.resolve', {
				selection: selectionOf({ machine: 'Nope', process: 'x', filament: 'y' })
			})
		).rejects.toMatchObject({ code: ERROR.PRESET_NOT_FOUND });
	});

	it('lists presets', async () => {
		const { presets } = await open().call('profiles.list', { kind: 'filament' });
		expect(presets.find((p) => p.name === 'Bambu PLA Basic @BBL X2D')).toMatchObject({
			instantiable: true,
			filamentType: 'PLA',
			compatiblePrinters: ['Bambu Lab X2D 0.4 nozzle']
		});
	});

	it.each(MODEL_CODES)('slices a job for %s into a file that printer accepts', async (code) => {
		const e = open();
		const before = install.runs().length;
		const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
		const r = await sliceModel({
			engine: e,
			stl: writeStl(box()),
			name: 'Test box',
			thumbnail: png,
			settings: settings(code, { color: '#ff7a2f' })
		});
		const file = readSliced(r.data);
		expect(file.printerModelId).toBe(code);
		// The fake stands the 10 mm box up to 20 mm when orienting: 100 layers of 0.2 mm.
		expect(file.plates[0]).toMatchObject({ index: 1, layers: 100 });
		expect(file.plates[0].filaments[0]).toMatchObject({ type: 'PLA', color: '#FF7A2F' });
		expect(file.thumbnails.get(1)?.equals(png)).toBe(true);
		expect(r).toMatchObject({ backend: 'bambu-studio-cli', minutes: 20, grams: 4.3 });
		const runs = install.runs().slice(before);
		// Orient, arrange, then slice: three runs of the command line.
		expect(runs.map((x) => x.args.includes('--slice'))).toEqual([false, false, true]);
		const m = PRINTER_MODELS[code];
		expect(runs[2].machine).toMatchObject({
			name: `${m.name} 0.4 nozzle`,
			type: 'machine',
			from: 'system'
		});
		expect(runs[2].process).toMatchObject({
			name: `0.20mm Standard @BBL ${m.short}`,
			sparse_infill_density: '15%',
			enable_support: '0'
		});
		expect(runs[2].filaments[0]).toMatchObject({
			name: `Bambu PLA Basic @BBL ${m.short}`,
			filament_colour: ['#FF7A2F']
		});
	});

	it('uses the job’s layer height, supports and material', async () => {
		const e = open();
		const before = install.runs().length;
		await sliceModel({
			engine: e,
			stl: writeStl(box()),
			name: 'Box',
			settings: settings('C12', {
				layerHeight: '0.16',
				supports: 'Tree',
				material: 'PETG',
				infill: 40
			})
		});
		const run = install.runs().slice(before).at(-1)!;
		expect(run.process).toMatchObject({
			name: '0.16mm Standard @BBL P1S',
			enable_support: '1',
			support_type: 'tree(auto)',
			sparse_infill_density: '40%'
		});
		expect(run.filaments[0].name).toBe('Bambu PETG HF @BBL P1S');
	});

	it('bakes the oriented and arranged transform into the STL it slices', async () => {
		const e = open();
		const selection = selectionOf({
			machine: 'Bambu Lab A1 mini 0.4 nozzle',
			process: '0.20mm Standard @BBL A1 mini',
			filament: 'Bambu PLA Basic @BBL A1 mini'
		});
		const presets = await e.call('profiles.resolve', { selection });
		const stl = path.join(work, 'tall.stl');
		fs.writeFileSync(stl, writeStl(box(20, 20, 10)));
		await e.call('mesh.put', { meshId: 'tall', path: stl, format: 'stl' });
		const { projectId } = await e.call('project.create', { presets: selection });
		const project = emptyProject(selection);
		project.objects = [
			{
				id: 'o1',
				name: 'Box',
				parts: [
					{
						id: 'p1',
						name: 'Box',
						type: 'model',
						mesh: 'tall',
						transform: [...IDENTITY],
						config: {}
					}
				],
				instances: [{ id: 'i1', transform: [...IDENTITY], printable: true }],
				config: {},
				heightRanges: [],
				printable: true
			}
		];
		project.plates = [
			{
				index: 1,
				name: '',
				locked: false,
				instances: [{ objectId: 'o1', instanceId: 'i1' }],
				config: {}
			}
		];
		await e.call('project.sync', { projectId, project, presets });
		const { objects } = await e.call('orient', { projectId, objectIds: ['o1'] });
		// Stood up about X where it stood: the same centre (10, 10), resting on the bed.
		near(objects[0].transform, [1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 15, 0]);
		project.objects[0].instances[0].transform = objects[0].transform;
		await e.call('project.sync', { projectId, project, presets });
		const { instances } = await e.call('arrange', { projectId, plate: 1 });
		// Arranging keeps the orientation and moves the centre to where the fake puts it (60, 100).
		expect(instances[0]).toMatchObject({ objectId: 'o1', instanceId: 'i1', plate: 1 });
		near(instances[0].transform, [1, 0, 0, 0, 0, 1, 0, -1, 0, 50, 105, 0]);
		// Sliced with the orientation baked in: 20 mm tall, 100 layers.
		project.objects[0].instances[0].transform = instances[0].transform;
		await e.call('project.sync', { projectId, project, presets });
		expect((await e.call('slice', { projectId, plate: 1 })).layers).toBe(100);
	});

	/** A synced project of 20 × 20 × 10 boxes for the P1S: `at` is each instance's plate and position. */
	async function boxes(e: CliEngine, at: { plate: number; x: number; y: number }[], plates = 1) {
		const selection = selectionOf({
			machine: 'Bambu Lab P1S 0.4 nozzle',
			process: '0.20mm Standard @BBL P1S',
			filament: 'Bambu PLA Basic @BBL P1S'
		});
		const presets = await e.call('profiles.resolve', { selection });
		const stl = path.join(work, 'box.stl');
		fs.writeFileSync(stl, writeStl(box()));
		await e.call('mesh.put', { meshId: 'box', path: stl, format: 'stl' });
		const { projectId } = await e.call('project.create', { presets: selection });
		const project = emptyProject(selection);
		project.objects = at.map((a, i) => ({
			id: `o${i + 1}`,
			name: `Box ${i + 1}`,
			parts: [
				{
					id: 'p1',
					name: 'Box',
					type: 'model' as const,
					mesh: 'box',
					transform: [...IDENTITY] as Transform,
					config: {}
				}
			],
			instances: [
				{
					id: 'i1',
					transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, a.x, a.y, 0] as Transform,
					printable: true
				}
			],
			config: {},
			heightRanges: [],
			printable: true
		}));
		project.plates = Array.from({ length: plates }, (_, p) => ({
			index: p + 1,
			name: '',
			locked: false,
			instances: at
				.map((a, i) => ({ a, ref: { objectId: `o${i + 1}`, instanceId: 'i1' } }))
				.filter(({ a }) => a.plate === p + 1)
				.map(({ ref }) => ref),
			config: {}
		}));
		await e.call('project.sync', { projectId, project, presets });
		return { projectId, project, presets };
	}

	it('slices and arranges a later plate at the bed origin, with that plate’s settings', async () => {
		const e = open();
		// Two plates side by side: plate 2 starts 256 × 1.2 = 307.2 mm along x.
		const { projectId, project, presets } = await boxes(
			e,
			[
				{ plate: 1, x: 20, y: 20 },
				{ plate: 2, x: 307.2 + 100, y: 100 }
			],
			2
		);
		project.plates[1].bedType = 'Cool Plate';
		project.plates[1].config = { wall_loops: '5' };
		await e.call('project.sync', { projectId, project, presets });
		const before = install.runs().length;
		expect((await e.call('slice', { projectId, plate: 2 })).layers).toBe(50);
		const run = install.runs().slice(before)[0];
		// Only plate 2's box, where it stands on that plate, kept there (--arrange 0).
		expect(run.inputs).toHaveLength(1);
		expect(run.inputs[0][0]).toBeCloseTo(100, 3);
		expect(run.inputs[0][1]).toBeCloseTo(100, 3);
		expect(run.args.join(' ')).toContain('--curr-bed-type Cool Plate');
		expect(run.args.join(' ')).toContain('--arrange 0');
		expect(run.process.wall_loops).toBe('5');

		const { instances } = await e.call('arrange', { projectId, plate: 2 });
		// The fake centres it at (60, 100) on the bed: back in project coordinates on plate 2.
		expect(instances).toHaveLength(1);
		expect(instances[0]).toMatchObject({ objectId: 'o2', plate: 2 });
		near(instances[0].transform, [1, 0, 0, 0, 1, 0, 0, 0, 1, 307.2 + 50, 90, 0]);
	});

	it('says so when the plate cannot take everything it arranges', async () => {
		const e = open();
		// The fake puts object i at x = 60 + 70·i: the fourth box lands off the 256 mm bed.
		const { projectId } = await boxes(
			e,
			[0, 1, 2, 3].map(() => ({ plate: 1, x: 0, y: 0 }))
		);
		await expect(e.call('arrange', { projectId, plate: 1 })).rejects.toMatchObject({
			code: ERROR.OUTSIDE_PLATE
		});
		const { projectId: three } = await boxes(
			e,
			[0, 1, 2].map(() => ({ plate: 1, x: 0, y: 0 }))
		);
		expect((await e.call('arrange', { projectId: three, plate: 'all' })).instances).toHaveLength(3);
	});

	it('keeps each project’s files apart, even across engines sharing a folder', async () => {
		const dir = fs.mkdtempSync(path.join(work, 'shared-'));
		const location = {
			kind: 'bambu-studio-cli' as const,
			path: install.bin,
			resourcesDir: install.resources,
			source: 'installed' as const
		};
		const a = new CliEngine({ location, workDir: dir });
		const b = new CliEngine({ location, workDir: dir });
		const presets = selectionOf({ machine: 'x', process: 'y', filament: 'z' });
		const pa = (await a.call('project.create', { presets })).projectId;
		const pb = (await b.call('project.create', { presets })).projectId;
		expect(pa).not.toBe(pb);
		await a.call('project.close', { projectId: pa });
		expect(fs.existsSync(path.join(dir, pb))).toBe(true);
		await Promise.all([a.close(), b.close()]);
	});

	it('reports a failed slice in the slicer’s own words', async () => {
		const e = open({ FAKE_CLI_FAIL: '1' });
		await expect(
			sliceModel({ engine: e, stl: writeStl(box()), name: 'Box', settings: settings('N6') })
		).rejects.toThrow('Nothing to be sliced');
	});

	it('stops the command line when the task is cancelled', async () => {
		const e = open({ FAKE_CLI_SLOW: '5000' });
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 200);
		const started = Date.now();
		await expect(
			sliceModel({
				engine: e,
				stl: writeStl(box()),
				name: 'Box',
				settings: settings('N6'),
				signal: abort.signal
			})
		).rejects.toThrow('Stopped');
		expect(Date.now() - started).toBeLessThan(4000);
	});

	it('warns about what the command line cannot take', async () => {
		const e = open();
		const selection = selectionOf({
			machine: 'Bambu Lab X2D 0.4 nozzle',
			process: '0.20mm Standard @BBL X2D',
			filament: 'Bambu PLA Basic @BBL X2D'
		});
		const presets = await e.call('profiles.resolve', { selection });
		const stl = path.join(work, 'box.stl');
		fs.writeFileSync(stl, writeStl(box()));
		await e.call('mesh.put', { meshId: 'm1', path: stl, format: 'stl' });
		const { projectId } = await e.call('project.create', { presets: selection });
		const project = emptyProject(selection);
		project.objects = [
			{
				id: 'o1',
				name: 'Box',
				parts: [
					{
						id: 'p1',
						name: 'Box',
						type: 'model',
						mesh: 'm1',
						transform: [...IDENTITY],
						config: {}
					},
					{
						id: 'p2',
						name: 'Blocker',
						type: 'support_blocker',
						mesh: 'm1',
						transform: [...IDENTITY],
						config: {}
					}
				],
				instances: [
					{ id: 'i1', transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 50, 50, 0], printable: true }
				],
				config: { wall_loops: '4' },
				heightRanges: [],
				printable: true
			}
		];
		project.plates = [
			{
				index: 1,
				name: '',
				locked: false,
				instances: [{ objectId: 'o1', instanceId: 'i1' }],
				config: {}
			}
		];
		expect((await e.call('project.sync', { projectId, project, presets })).errors).toEqual([]);
		const stats = await e.call('slice', { projectId, plate: 1 });
		expect(stats.warnings.map((w) => w.code)).toEqual(['CLI_PART_IGNORED', 'CLI_SETTINGS_IGNORED']);
		await expect(
			e.call('export.gcode3mf', {
				projectId,
				plates: [2],
				path: path.join(work, 'x.3mf'),
				thumbnails: 'engine'
			})
		).rejects.toMatchObject({ code: ERROR.EXPORT_FAILED });
		await expect(e.call('preview.get', { projectId, plate: 1, path: 'x' })).rejects.toMatchObject({
			code: ERROR.CAPABILITY_MISSING
		});
		await e.call('project.close', { projectId });
		await expect(e.call('slice', { projectId, plate: 1 })).rejects.toMatchObject({
			code: ERROR.PROJECT_NOT_FOUND
		});
	});
});
