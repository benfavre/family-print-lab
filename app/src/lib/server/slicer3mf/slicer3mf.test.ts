// Reading and writing project 3MFs against real files from Bambu Studio and OrcaSlicer (and our
// synthesised feature files): every fixture reads, round-trips through the writer without loss, keeps
// passthrough bytes, painting strings and transforms exactly.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readZip } from '../cad/mesh';
import { read3mf, type ReadResult } from './read';
import { write3mf } from './write';
import { MODEL_CONFIG_FILE } from './constants';

const dir = path.join(import.meta.dirname, '__fixtures__');
const fixtures = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith('.3mf'))
	.sort();

const load = (name: string) => read3mf(fs.readFileSync(path.join(dir, name)));
const roundTrip = (r: ReadResult) =>
	read3mf(
		write3mf(r.project, {
			mesh: (id) => {
				const m = r.meshes.get(id);
				if (!m) throw new Error(`missing mesh ${id}`);
				return m.geometry;
			}
		})
	);

describe('fixtures', () => {
	it('has the files the README lists', () => {
		expect(fixtures.length).toBeGreaterThanOrEqual(7);
		const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
		for (const f of fixtures) expect(readme).toContain(f);
	});

	for (const name of fixtures) {
		describe(name, () => {
			const first = load(name);

			it('reads into a consistent project', () => {
				const p = first.project;
				expect(p.objects.length).toBeGreaterThan(0);
				for (const o of p.objects) {
					expect(o.parts.length).toBeGreaterThan(0);
					expect(o.instances.length).toBeGreaterThan(0);
					for (const part of o.parts) {
						expect(p.meshes[part.mesh]).toBeDefined();
						expect(first.meshes.get(part.mesh)).toBeDefined();
						expect(part.transform).toHaveLength(12);
					}
				}
				const ids = new Set(p.objects.flatMap((o) => o.instances.map((i) => `${o.id}/${i.id}`)));
				for (const plate of p.plates)
					for (const ref of plate.instances)
						expect(ids).toContain(`${ref.objectId}/${ref.instanceId}`);
			});

			it('round-trips without loss', () => {
				const second = roundTrip(first);
				expect(second.project).toEqual(first.project);
				expect([...second.meshes.keys()].sort()).toEqual([...first.meshes.keys()].sort());
				// And is stable from then on.
				expect(roundTrip(second).project).toEqual(second.project);
			});

			it('keeps passthrough files byte for byte', () => {
				const original = readZip(fs.readFileSync(path.join(dir, name)), () => 'all');
				const written = readZip(
					write3mf(first.project, { mesh: (id) => first.meshes.get(id)!.geometry }),
					() => 'all'
				);
				for (const file of Object.keys(first.project.passthrough))
					expect(written.get(file)?.equals(original.get(file)!), file).toBe(true);
			});
		});
	}
});

describe('Bambu Studio projects', () => {
	it('reads parts, modifiers, shared meshes and plates (auto_pa_line_dual)', () => {
		const { project: p } = load('bambu-auto-pa-line-dual.3mf');
		expect(p.objects).toHaveLength(8);
		const o = p.objects[0];
		expect(o.sourceId).toBe(3);
		expect(o.name).toBe('立方体');
		expect(o.config.extruder).toBe('1');
		expect(o.parts.map((x) => x.type)).toEqual(['model', 'modifier']);
		expect(o.parts[1].config.outer_wall_speed).toBe('80,nil,80,nil');
		expect(o.parts[0].source?.source_file).toContain('自动流量校准展示模型.3mf');
		// Every object uses sub-objects 1 and 2 of 3D/Objects/object_1.model: two unit cubes, one mesh.
		expect(new Set(p.objects.flatMap((x) => x.parts.map((y) => y.mesh))).size).toBe(1);
		expect(p.objects.every((x) => x.parts.map((y) => y.sourceId).join() === '1,2')).toBe(true);
		expect(Object.keys(p.meshes)).toHaveLength(1);
		expect(p.objects[0].parts[0].transform).toEqual([
			3.12499995, 0, 0, 0, 0.0156249998, 0, 0, 0, 0.00781249988, 0, 0, 0
		]);
		expect(p.objects[0].instances[0].transform).toEqual([
			1.22222222, 0, 0, 0, 1, 0, 0, 0, 1, 113.888889, 50, 0.1
		]);
		expect(p.objects.every((x) => x.cutInfo?.includes('cut_id'))).toBe(true);
		expect(p.plates).toHaveLength(1);
		expect(p.filaments.length).toBeGreaterThan(1);
	});

	it('reads custom G-code per layer and keeps <assemble> (pa_pattern)', () => {
		const { project: p } = load('bambu-pa-pattern.3mf');
		const g = p.plates[0].customGcode!;
		expect(g.items[0]).toMatchObject({ topZ: 0.25, type: 4, extruder: -858993460 });
		expect(g.items[0].extra).toContain('\nG1 E-.8 F1800\n');
		expect(p.modelSettingsXml?.[0]).toMatch(/^<assemble>/);
		expect(p.plates[0].thumbnail).toBe('Metadata/plate_1.png');
		expect(p.plates[0].config.top_file).toBe('Metadata/top_1.png');
		expect(p.objects[0].instances[0].identifyId).toBe(58);
		expect(p.meta.application).toBe('BambuStudio-01.07.03.04');
		expect(p.presets.printer.name).not.toBe('');
		expect(p.passthrough['Metadata/plate_1.png']).toBeDefined();
	});

	it('reads a plain 3MF as one object on one plate (Büchse)', () => {
		const { project: p } = load('bambu-test-buchse.3mf');
		expect(p.objects).toHaveLength(1);
		expect(p.objects[0].parts).toHaveLength(1);
		expect(p.meshes[p.objects[0].parts[0].mesh]).toMatchObject({ triangles: 12, vertices: 8 });
		expect(p.meshes[p.objects[0].parts[0].mesh].bbox).toEqual([0, 0, 0, 10, 20, 30]);
		expect(p.plates).toEqual([
			{
				index: 1,
				name: '',
				locked: false,
				instances: [{ objectId: 'o1', instanceId: 'o1-i1' }],
				config: {}
			}
		]);
	});

	it('reads OrcaSlicer projects with many parts and filaments (OrcaBadge)', () => {
		const { project: p } = load('orca-badge.3mf');
		expect(p.meta.extras?.OrcaSlicer).toBe('2.5.0-dev');
		expect(p.objects.length).toBeGreaterThan(1);
		const parts = p.objects.flatMap((o) => o.parts);
		expect(new Set(parts.map((x) => x.filament)).size).toBeGreaterThan(2);
		expect(p.plates[0].filamentSequence).toEqual({
			nozzle_sequence: [],
			optimal_assignment: [],
			sequence: []
		});
	});

	it('writes model_settings.config in upstream layout', () => {
		const r = load('bambu-pa-pattern.3mf');
		const files = readZip(
			write3mf(r.project, { mesh: (id) => r.meshes.get(id)!.geometry }),
			() => 'all'
		);
		const xml = files.get(MODEL_CONFIG_FILE)!.toString();
		expect(xml).toContain('<object id="2">');
		expect(xml).toContain('<part id="1" subtype="normal_part">');
		expect(xml).toContain('<metadata key="plater_id" value="1"/>');
		expect(xml).toContain('<metadata key="identify_id" value="58"/>');
		expect(files.get('3D/3dmodel.model')!.toString()).toContain(
			'<component p:path="/3D/Objects/object_1.model" objectid="1"'
		);
	});
});

describe('synthesised feature files', () => {
	it('reads painting, part types, text, height ranges and plate settings', () => {
		const { project: p } = load('synth-bambu-features.3mf');
		expect(p.meta).toMatchObject({
			title: 'Every feature',
			designer: 'Family Print Lab',
			license: 'CC-BY-4.0',
			origin: 'Family Print Lab tests',
			// Upstream escapes metadata twice and unescapes it twice.
			description: 'Synthesised fixture & test',
			createdAt: '2026-09-01'
		});
		const [cube, tetra] = p.objects;
		expect(cube.parts.map((x) => x.type)).toEqual([
			'model',
			'modifier',
			'negative',
			'support_blocker',
			'support_enforcer',
			'model'
		]);
		expect(cube.parts[0].paint).toEqual({
			supports: { 0: '4', 1: '8' },
			seam: { 1: '4' },
			color: { 2: '0C', 3: '481', 4: '1C' },
			fuzzySkin: { 2: '4' }
		});
		expect(cube.parts[0].source).toMatchObject({ source_file: 'cube.stl', source_offset_x: '0.5' });
		expect(cube.parts[1]).toMatchObject({ filament: 2, config: { sparse_infill_density: '40%' } });
		expect(cube.parts[1].transform).toEqual([4, 0, 0, 0, 4, 0, 0, 0, 2, 3, 3, 0]);
		expect(cube.parts[5].text?.text).toBe('Hi & bye');
		expect(cube.parts[5].uuid).toBe('7b0f0a44-4c0b-4bde-9b41-2f3a1d6a9e11');
		expect(cube.parts[0].xml?.[0]).toMatch(/^<mesh_stat /);
		expect(cube.config).toEqual({ extruder: '1', wall_loops: '3' });
		expect(cube.instances.map((i) => [i.printable, i.identifyId])).toEqual([
			[true, 101],
			[false, 102]
		]);
		expect(cube.layerHeightProfile).toEqual([0, 0.2, 4, 0.12, 10, 0.28]);
		expect(cube.heightRanges).toEqual([
			{ minZ: 0, maxZ: 2.5, config: { layer_height: '0.12', extruder: '2' } },
			{ minZ: 2.5, maxZ: 6, config: { sparse_infill_density: '<25%>' } }
		]);
		expect(tetra.extras).toEqual({ module: 'calibration' });
		expect(tetra.instances[0].transform[11]).toBe(-0);
		expect(p.plates[0]).toMatchObject({
			index: 1,
			name: 'Main',
			locked: false,
			bedType: 'Textured PEI Plate',
			printSequence: 'by object',
			spiralVase: false,
			filamentMapMode: 'Manual',
			filamentMaps: [1, 2, 1],
			firstLayerSequence: [2, 1, 3],
			otherLayersSequence: [1, 2],
			thumbnail: 'Metadata/plate_1.png',
			config: { other_layers_print_sequence_nums: '1', pattern_bbox_file: 'Metadata/plate_1.json' },
			filamentSequence: { nozzle_sequence: [0, 1], optimal_assignment: [1, 0], sequence: [1, 2, 1] }
		});
		expect(p.plates[1]).toMatchObject({
			name: 'Second & last',
			locked: true,
			spiralVase: true,
			customGcode: {
				mode: 'MultiAsSingle',
				items: [
					{ topZ: 3.2, type: 1, extruder: 1, color: '', extra: 'Swap to red' },
					{ topZ: 5.2, type: 0, extruder: 2, color: '#FF0000', extra: '' }
				]
			}
		});
		expect(p.presets.printer).toEqual({
			kind: 'printer',
			name: 'Bambu Lab H2D 0.4 nozzle',
			source: 'project'
		});
		expect(p.filaments.map((f) => [f.color, f.type])).toEqual([
			['#FFFFFF', 'PLA'],
			['#FF0000', 'PLA'],
			['#00AE42', 'PETG']
		]);
		expect(p.projectConfig).toMatchObject({ layer_height: '0.2', nozzle_diameter: ['0.4', '0.4'] });
		expect(p.projectConfig.filament_colour).toBeUndefined();
		expect(Object.keys(p.passthrough).sort()).toEqual([
			'Auxiliaries/Model Pictures/Größe.txt',
			'Metadata/plate_1.json',
			'Metadata/plate_1.png',
			'Metadata/slice_info.config',
			'[Content_Types].xml',
			'_rels/.rels'
		]);
	});

	it('splits PrusaSlicer triangle-range volumes into parts and moves their painting along', () => {
		const { project: p } = load('synth-prusa-volumes.3mf');
		expect(p.objects).toHaveLength(1);
		const [body, denser] = p.objects[0].parts;
		expect(body).toMatchObject({ name: 'Body', type: 'model', filament: 1 });
		expect(body.paint).toEqual({ supports: { 0: '4' } });
		expect(body.source).toEqual({ matrix: '1 0 0 10 0 1 0 10 0 0 1 10 0 0 0 1' });
		expect(denser).toMatchObject({
			name: 'Denser',
			type: 'modifier',
			config: { fill_density: '50%' }
		});
		expect(denser.paint).toEqual({ color: { 1: '8' }, seam: { 2: '4' } });
		expect(p.meshes[body.mesh].triangles).toBe(12);
		expect(p.meshes[denser.mesh].triangles).toBe(4);
		expect(p.objects[0].config).toEqual({ layer_height: '0.15' });
		expect(p.objects[0].layerHeightProfile).toEqual([0, 0.15, 10, 0.1, 20, 0.2]);
		expect(p.passthrough['Metadata/Slic3r_PE.config']).toBeDefined();
	});

	it('writes a file other readers can take apart the same way', () => {
		const r = load('synth-bambu-features.3mf');
		const files = readZip(
			write3mf(r.project, { mesh: (id) => r.meshes.get(id)!.geometry }),
			() => 'all'
		);
		const sub = files.get('3D/Objects/object_1.model')!.toString();
		expect(sub).toMatch(
			/<triangle v1="\d+" v2="\d+" v3="\d+" paint_supports="8" paint_seam="4"\/>/
		);
		expect(sub).toContain('paint_color="481"');
		expect(files.get('3D/3dmodel.model')!.toString()).toContain(
			'<metadata name="Description">Synthesised fixture &amp;amp; test</metadata>'
		);
		expect(files.get('Metadata/layer_config_ranges.xml')!.toString()).toContain(
			'<option opt_key="sparse_infill_density">&lt;25%&gt;</option>'
		);
		expect(files.get('Metadata/model_settings.config')!.toString()).toContain(
			'<metadata key="spiral_mode" value="true"/>'
		);
	});
});
