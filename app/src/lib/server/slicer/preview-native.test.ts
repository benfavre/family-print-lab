// Cross-language conformance: decode the native PLPV container with the browser's real decoder.
// Requires a full engine; the protocol-only build exercises capability gating in conformance.test.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyProject, IDENTITY } from '$lib/shared/slicer/project';
import { decodePreview, PREVIEW_FEATURES, TRAVEL_FEATURE } from '$lib/shared/slicer/preview';
import { ERROR } from '$lib/shared/slicer/protocol';
import { writeStl } from '../cad/mesh';
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

describe.runIf(!!BIN)('native toolpath preview', () => {
	it(
		'writes browser-readable layers, filters travel, and invalidates previews after edits',
		{ timeout: 300_000 },
		async ({ skip }) => {
			const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-preview-é-印刷-'));
			const engine = await StdioEngine.open({ command: BIN!, workDir: work });
			try {
				if (!engine.has('preview.v1')) skip();
				const selection = selectionOf({
					machine: 'Bambu Lab P1S 0.4 nozzle',
					process: '0.20mm Standard @BBL X1C',
					filament: 'Bambu PLA Basic @BBL P1S 0.4 nozzle'
				});
				const presets = await engine.call('profiles.resolve', { selection });
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
							filament: 1
						}
					],
					instances: [
						{
							id: `i${i}`,
							transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 90 + i * 30, 110, 0],
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
				await engine.call('project.sync', { projectId, project, presets });
				expect(
					fs.readdirSync(path.join(work, 'scratch')).filter((name) => name.startsWith('config-'))
				).toEqual([]);
				const output = path.join(work, 'aperçu-模型.bin');
				await expect(
					engine.call('preview.get', { projectId, plate: 1, path: output })
				).rejects.toMatchObject({ code: ERROR.INVALID_PARAMS });
				const stats = await engine.call('slice', { projectId, plate: 1 });
				expect(stats.objects.map((o) => o.objectId)).toEqual(['o0', 'o1']);
				for (const object of stats.objects) {
					expect(object.grams).toBeGreaterThan(0);
					expect(object.seconds).toBeGreaterThan(0);
					expect(Number.isFinite(object.seconds)).toBe(true);
				}
				expect(stats.objects.reduce((sum, o) => sum + (o.grams ?? 0), 0)).toBeLessThanOrEqual(
					stats.filaments.reduce((sum, f) => sum + f.grams, 0) * 1.01
				);
				expect(stats.objects.reduce((sum, o) => sum + (o.seconds ?? 0), 0)).toBeLessThanOrEqual(
					stats.seconds
				);
				let allSegments = 0;
				for (const travel of [true, false]) {
					const result = await engine.call('preview.get', {
						projectId,
						plate: 1,
						path: output,
						travel
					});
					const decoded = decodePreview(fs.readFileSync(output));
					expect(decoded.header).toEqual(result.header);
					expect(decoded.header.source).toBe('engine');
					expect(decoded.header.features).toEqual(PREVIEW_FEATURES);
					expect(decoded.header.totalSeconds).toBe(stats.seconds);
					expect(decoded.header.segments).toBeGreaterThan(0);
					expect(decoded.seg.every(Number.isFinite)).toBe(true);
					expect(decoded.header.layers.reduce((n, l) => n + l.count, 0)).toBe(
						decoded.header.segments
					);
					let offset = 0;
					for (const layer of decoded.header.layers) {
						expect(layer.first).toBe(offset);
						offset += layer.count;
					}
					const hasTravel = decoded.attr.some(
						(feature, i) => i % 4 === 0 && feature === TRAVEL_FEATURE
					);
					expect(hasTravel).toBe(travel);
					if (travel) allSegments = decoded.header.segments;
					else expect(decoded.header.segments).toBeLessThan(allSegments);
				}
				await engine.call('project.sync', { projectId, project, presets });
				await expect(
					engine.call('preview.get', { projectId, plate: 1, path: output })
				).rejects.toMatchObject({ code: ERROR.INVALID_PARAMS });
			} finally {
				await engine.close();
				fs.rmSync(work, { recursive: true, force: true });
			}
		}
	);
});
