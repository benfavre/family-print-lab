// Auto grouping must slice both filaments and preserve the resolved maps in exported metadata.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyProject, IDENTITY } from '$lib/shared/slicer/project';
import { writeStl, readZip } from '../cad/mesh';
import { StdioEngine } from './engine';
import { selectionOf } from './profile-book';

const BIN = process.env.PRINTLAB_SLICER_PATH;

function cube() {
	const v = [
		[0, 0, 0],
		[10, 0, 0],
		[10, 10, 0],
		[0, 10, 0],
		[0, 0, 2],
		[10, 0, 2],
		[10, 10, 2],
		[0, 10, 2]
	];
	const faces = [
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
	return writeStl(new Float32Array(faces.flatMap((f) => f.flatMap((i) => v[i]))));
}

describe.runIf(!!BIN)('native multi-extruder grouping', () => {
	it.for(['H2D', 'X2D'])(
		'%s groups two filaments without GUI plate state',
		{ timeout: 300_000 },
		async (model, { skip }) => {
			const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-grouping-'));
			const engine = await StdioEngine.open({ command: BIN!, workDir: work });
			try {
				if (!engine.has('slice')) skip();
				const selection = selectionOf({
					machine: `Bambu Lab ${model} 0.4 nozzle`,
					process: `0.20mm Standard @BBL ${model}`,
					filament: `Bambu PLA Basic @BBL ${model}${model === 'X2D' ? ' 0.4 nozzle' : ''}`
				});
				selection.filaments.push({ ...selection.filaments[0] });
				const presets = await engine.call('profiles.resolve', { selection });
				if (model === 'X2D') {
					// Resolving before grouping must retain both material profiles' Bowden variants.
					const variants = presets.full.filament_extruder_variant as string[];
					const owners = presets.full.filament_self_index as string[];
					for (const id of ['1', '2'])
						expect(variants.some((v, i) => v === 'Bowden Standard' && owners[i] === id)).toBe(true);
				}
				const meshPath = path.join(work, 'cube.stl');
				fs.writeFileSync(meshPath, cube());
				const mesh = await engine.call('mesh.put', {
					meshId: 'cube',
					path: meshPath,
					format: 'stl'
				});
				const { projectId } = await engine.call('project.create', { presets: selection });
				const project = emptyProject(selection);
				project.meshes.cube = {
					id: 'cube',
					vertices: mesh.triangles * 3,
					triangles: mesh.triangles,
					bbox: mesh.bbox,
					storage: { kind: 'file', path: meshPath }
				};
				project.objects = [0, 1].map((i) => ({
					id: `o${i}`,
					name: `Cube ${i}`,
					config: {},
					heightRanges: [],
					printable: true,
					parts: [
						{
							id: `p${i}`,
							name: 'Cube',
							type: 'model',
							mesh: 'cube',
							transform: [...IDENTITY],
							config: {},
							filament: i + 1
						}
					],
					instances: [
						{
							id: `i${i}`,
							transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 110 + i * 30, 140, 0],
							printable: true
						}
					]
				}));
				project.plates = [
					{
						index: 1,
						name: '',
						locked: false,
						bedType: 'Textured PEI Plate',
						config: {},
						instances: [0, 1].map((i) => ({ objectId: `o${i}`, instanceId: `i${i}` }))
					}
				];

				project.projectConfig.filament_map_mode = 'Auto For Flush';
				// Print::get_physical_unprintable_filaments (Print.cpp:3086 at the pin) uses bit N
				// for physical nozzle N. Keep automatic grouping, but require one material on each.
				if (model === 'X2D') project.projectConfig.filament_printable = ['1', '2'];
				project.projectConfig.wipe_tower_x = ['80'];
				project.projectConfig.wipe_tower_y = ['200'];
				project.projectConfig.filament_colour = ['#FF0000', '#0000FF'];
				await engine.call('project.sync', { projectId, project, presets });
				const stats = await engine.call('slice', { projectId, plate: 1 });
				expect(Number.isFinite(stats.seconds)).toBe(true);
				expect(stats.seconds).toBeGreaterThan(0);
				expect(stats.filaments.map((f) => f.index).sort()).toEqual([1, 2]);
				for (const filament of stats.filaments) {
					expect(Number.isFinite(filament.grams)).toBe(true);
					expect(filament.grams).toBeGreaterThan(0);
				}
				const output = path.join(work, 'grouped.gcode.3mf');
				await engine.call('export.gcode3mf', {
					projectId,
					plates: [1],
					path: output,
					thumbnails: 'engine'
				});
				const files = readZip(fs.readFileSync(output), (n) =>
					n.endsWith('.gcode') ? 'all' : false
				);
				const gcode = [...files.values()][0].toString('utf8');
				expect(gcode).not.toContain('R-2147483648');
				const maps = gcode
					.match(/^; filament_map = (.+)$/m)?.[1]
					.split(',')
					.map(Number);
				expect(maps).toHaveLength(2);
				expect(maps!.every((n) => n === 1 || n === 2)).toBe(true);
				if (model === 'X2D') {
					expect(maps).toEqual([1, 2]);
					const retractions = gcode
						.match(/^; filament_retraction_length = (.+)$/m)?.[1]
						.split(/[;,]/)
						.map(Number);
					// The pinned PLA Basic profile retracts 0.4 mm on Direct Drive, 3 mm on Bowden.
					expect(retractions).toEqual([0.4, 3]);
				}
			} finally {
				await engine.close();
				fs.rmSync(work, { recursive: true, force: true });
			}
		}
	);
});
