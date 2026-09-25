import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseParameters, renderScad, STARTER_SCAD } from './openscad';
import { importMesh, parse3mf, parseObj, parseStl, stats, write3mf, writeStl } from './mesh';
import { applyOp, bestDownDirection, isSolid } from './geometry';
import { findBlender, runJob } from './blender';
import { openDatabase } from '../db';
import { Lab } from '../lab';
import { ModelStore, RenderFailed } from '../models';
import { designPart } from '../ai/cad';
import type { Provider } from '../ai/providers';

const cube = async (size = 20) => (await renderScad(`cube(${size});`)).soup!;
const temp: string[] = [];
const tmpdir = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-cad-'));
	temp.push(d);
	return d;
};
afterEach(() => {
	for (const d of temp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('customizer parameters', () => {
	it('reads groups, ranges, steps, choices, booleans and strings, and stops at hidden and modules', () => {
		const params = parseParameters(`// A bin
/* [Size] */
// Inner width (mm)
width = 60; // [20:1:200]
depth = 40; // [10:90]
/* [Style] */
shape = "round"; // [round:Rounded, square:Square]
holes = 3; // [2, 3, 4]
lid = true;
label = "Pens"; // Text on the front
/* [Hidden] */
$fn = 64;
secret = 1;
module m() {}
after = 2;`);
		expect(params.map((p) => [p.name, p.type, p.group])).toEqual([
			['width', 'number', 'Size'],
			['depth', 'number', 'Size'],
			['shape', 'choice', 'Style'],
			['holes', 'choice', 'Style'],
			['lid', 'boolean', 'Style'],
			['label', 'string', 'Style']
		]);
		expect(params[0]).toMatchObject({
			min: 20,
			step: 1,
			max: 200,
			value: 60,
			description: 'Inner width (mm)'
		});
		expect(params[1]).toMatchObject({ min: 10, max: 90 });
		expect(params[2].options).toEqual([
			{ value: 'round', label: 'Rounded' },
			{ value: 'square', label: 'Square' }
		]);
		expect(params[3].options?.map((o) => o.value)).toEqual([2, 3, 4]);
		expect(params[5].description).toBe('Text on the front');
	});
});

describe('OpenSCAD rendering', () => {
	it('renders the starter part, applies parameter overrides, and renders text with the bundled fonts', async () => {
		const base = await renderScad(STARTER_SCAD);
		expect(base.ok).toBe(true);
		expect(stats(base.soup!).size.map(Math.round)).toEqual([60, 40, 30]);
		const wider = await renderScad(STARTER_SCAD, { width: 100, label: 'Hi' });
		expect(Math.round(stats(wider.soup!).size[0])).toBe(100);
		expect(wider.soup!.length).toBeGreaterThan(base.soup!.length); // the label adds geometry
	});

	it('reports syntax errors with line numbers and empty models as errors', async () => {
		const broken = await renderScad('cube(10);\nsphere(5\n');
		expect(broken.ok).toBe(false);
		expect(broken.diagnostics[0]).toMatchObject({ level: 'error', line: 2 });
		const empty = await renderScad('x = 1;');
		expect(empty.ok).toBe(false);
		expect(empty.diagnostics[0].message).toMatch(/no geometry/);
	});

	it('rejects unsafe parameter names', async () => {
		await expect(
			renderScad('cube(1);', { 'x); import("/etc/passwd"); y=(1': 1 })
		).rejects.toMatchObject({ status: 400 });
	});
});

describe('mesh formats', () => {
	it('round-trips binary STL, ASCII STL, 3MF and OBJ', async () => {
		const soup = await cube(10);
		expect(parseStl(writeStl(soup))).toEqual(soup);
		const ascii = `solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n`;
		expect(parseStl(Buffer.from(ascii)).length).toBe(9);
		const back = parse3mf(write3mf(soup, 'Cube'));
		expect(stats(back).volume).toBeCloseTo(1000, 3);
		expect(parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n').length).toBe(18); // quad -> 2 triangles
		expect(() => importMesh(Buffer.from('not a mesh'), 'stl')).toThrow(/not a valid STL/);
	});

	it('produces 3MF that Blender reads', { timeout: 60_000 }, async () => {
		if (!findBlender()) return expect(true).toBe(true);
		const dir = tmpdir();
		const file = path.join(dir, 'cube.stl');
		fs.writeFileSync(file, writeStl(await cube(12)));
		const report = await runJob('repair', file, path.join(dir, 'out.stl'));
		expect(report).toMatchObject({ non_manifold_edges: 0 });
	});
});

describe('geometry operations', () => {
	it('scales, mirrors, rotates, cuts, drills and combines while staying solid and on the bed', async () => {
		const base = await cube(20);
		const scaled = await applyOp(base, { op: 'scale', factor: [2, 1, 0.5] });
		expect(stats(scaled).size.map(Math.round)).toEqual([40, 20, 10]);
		expect(stats(scaled).min[2]).toBeCloseTo(0);
		const cut = await applyOp(base, { op: 'cut', axis: 'z', at: 5, keep: 'below' });
		expect(stats(cut).size[2]).toBeCloseTo(5);
		const drilled = await applyOp(base, { op: 'drill', x: 10, y: 10, diameter: 6 });
		expect(stats(drilled).volume).toBeLessThan(stats(base).volume - 400);
		const tall = await renderScad('cube([10, 10, 40]);');
		const flat = await applyOp(tall.soup!, { op: 'layFlat', normal: [1, 0, 0] });
		expect(
			stats(flat)
				.size.map(Math.round)
				.sort((a, b) => a - b)
		).toEqual([10, 10, 40]);
		expect(Math.round(stats(flat).size[2])).toBe(10);
		const both = await applyOp(base, {
			op: 'combine',
			mode: 'union',
			other: (await renderScad('translate([10,0,0]) cube(20);')).soup!
		});
		expect(stats(both).size.map(Math.round)).toEqual([30, 20, 20]);
		expect(await isSolid(both)).toBe(true);
	});

	it('auto-orients a part onto the side that needs no support', async () => {
		// A mushroom: printed as modelled, the wide cap overhangs; on its side the round stem does. Flipped
		// onto the cap it needs no support at all.
		const mushroom = (
			await renderScad(
				'$fn = 48; cylinder(d = 10, h = 30); translate([0, 0, 30]) cylinder(d = 40, h = 4);'
			)
		).soup!;
		expect(bestDownDirection(mushroom).map((v) => Math.round(v) + 0)).toEqual([0, 0, 1]);
		const flipped = await applyOp(mushroom, { op: 'autoOrient' });
		expect(stats(flipped).size.map(Math.round)).toEqual([40, 40, 34]);
		// The cap is now at the bottom: the lowest 3 mm spans the full 40 mm.
		const low = await applyOp(flipped, { op: 'cut', axis: 'z', at: 3, keep: 'below' });
		expect(Math.round(stats(low).size[0])).toBe(40);
	});

	it('raises and engraves text on a face, upright on walls', { timeout: 30_000 }, async () => {
		const box = await cube(40);
		const volume = stats(box).volume;
		// On the top face: raised letters add material and height.
		const top = await applyOp(box, {
			op: 'text',
			text: 'ALEX',
			font: 'bold',
			size: 10,
			depth: 1,
			mode: 'emboss',
			point: [20, 20, 40],
			normal: [0, 0, 1],
			angle: 0
		});
		expect(stats(top).size[2]).toBeCloseTo(41, 1);
		expect(stats(top).volume).toBeGreaterThan(volume + 50);
		expect(await isSolid(top)).toBe(true);
		// On the front wall (facing -Y): engraved, so no size change, less material; letters stand upright
		// (taller in Z than in Y) and span X.
		const front = await applyOp(box, {
			op: 'text',
			text: 'HI',
			font: 'bold',
			size: 12,
			depth: 1.5,
			mode: 'engrave',
			point: [20, 0, 20],
			normal: [0, -1, 0],
			angle: 0
		});
		expect(stats(front).size.map(Math.round)).toEqual([40, 40, 40]);
		expect(stats(front).volume).toBeLessThan(volume - 50);
		// Raised on the same wall, the part that sticks out in front is just the letters: upright (taller in Z
		// than deep in Y). After the edit the part is re-centred, so the wall's front is at y = -20.
		const raised = await applyOp(box, {
			op: 'text',
			text: 'HI',
			font: 'bold',
			size: 12,
			depth: 1.5,
			mode: 'emboss',
			point: [20, 0, 20],
			normal: [0, -1, 0],
			angle: 0
		});
		const out = await applyOp(raised, {
			op: 'cut',
			axis: 'y',
			at: stats(raised).min[1] + 1.4,
			keep: 'below'
		});
		expect(stats(out).size[2]).toBeGreaterThan(8);
		expect(stats(out).size[1]).toBeLessThan(1.5);
		await expect(
			applyOp(box, {
				op: 'text',
				text: '  ',
				font: 'bold',
				size: 10,
				depth: 1,
				mode: 'emboss',
				point: [0, 0, 40],
				normal: [0, 0, 1],
				angle: 0
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('lays out copies on the bed and refuses layouts that do not fit', async () => {
		const part = (await renderScad('cube([30, 20, 5]);')).soup!;
		const four = await applyOp(part, { op: 'copies', count: 4, gap: 5 });
		expect(stats(four).volume).toBeCloseTo(4 * 3000, 0);
		expect(stats(four).size.map(Math.round)).toEqual([65, 45, 5]);
		await expect(applyOp(part, { op: 'copies', count: 36, gap: 20 })).rejects.toMatchObject({
			status: 400
		});
	});

	it('cuts a part in two and rests each piece on its best flat face', async () => {
		// A cone: cut halfway, the top piece would stand on its point; it must be flipped onto the cut face.
		const cone = (await renderScad('$fn = 64; cylinder(h = 40, r1 = 20, r2 = 2);')).soup!;
		const both = await applyOp(cone, { op: 'cut', axis: 'z', at: 20, keep: 'both' });
		const s = stats(both);
		expect(s.volume).toBeCloseTo(stats(cone).volume, -1);
		expect(Math.round(s.size[2])).toBe(20);
		expect(s.size[0]).toBeGreaterThan(40 + 22 + 4); // side by side with a gap
		// Every piece rests on a large flat face: nothing needs support.
		const slice = await applyOp(both, { op: 'cut', axis: 'z', at: 0.5, keep: 'below' });
		// The bottom piece keeps its wide base (r = 20); the top piece is flipped onto its cut face (r = 11).
		expect(stats(slice).volume).toBeGreaterThan(
			0.5 * (Math.PI * 20 * 20 + Math.PI * 11 * 11) * 0.9
		);
	});

	it('refuses solid edits on open meshes and silly inputs', async () => {
		const open = (await cube(10)).slice(0, 9 * 10); // drop two faces
		await expect(applyOp(open, { op: 'center' })).rejects.toMatchObject({ status: 422 });
		await expect(applyOp(await cube(10), { op: 'scale', factor: [0, 1, 1] })).rejects.toMatchObject(
			{ status: 400 }
		);
		await expect(
			applyOp(await cube(10), { op: 'cut', axis: 'z', at: 50, keep: 'above' })
		).rejects.toMatchObject({ status: 400 });
	});
});

describe('model store', () => {
	const setup = () => {
		const db = openDatabase(':memory:');
		const lab = new Lab(db);
		const dir = tmpdir();
		const store = new ModelStore(db, lab, dir);
		const profileId = lab.createProfile({ name: 'Alex', color: 'blue' });
		const projectId = lab.createProject({ profileId, title: 'Desk tray' });
		return { db, lab, store, dir, projectId };
	};

	it(
		'versions parametric models, keeps broken code out, restores, and publishes to the workspace',
		{ timeout: 30_000 },
		async () => {
			const { lab, store, projectId } = setup();
			const id = await store.createParametric(projectId, 'Tray');
			await store.saveParametric(id, {
				source: STARTER_SCAD,
				params: { width: 90 },
				note: 'Wider'
			});
			await expect(
				store.saveParametric(id, { source: 'cube(', params: {} })
			).rejects.toBeInstanceOf(RenderFailed);
			const ws = lab.snapshot();
			const model = ws.models.find((m) => m.id === id)!;
			expect(model.versions.map((v) => [v.number, v.note])).toEqual([
				[2, 'Wider'],
				[1, 'Created']
			]);
			expect(Math.round(model.versions[0].sizeX)).toBe(90);
			store.restore(id, model.versions[1].id);
			expect(store.detail(id).current!.number).toBe(1);
			expect(store.detail(id).parameters.find((p) => p.name === 'width')?.value).toBe(60);
			const file = store.file(id, model.versions[0].id, '3mf');
			expect(file.name).toBe('Tray-v2.3mf');
			expect(stats(parse3mf(file.data)).size[0]).toBeCloseTo(90, 0);
		}
	);

	it(
		'imports meshes, edits them as new versions, and cleans up files and job links on delete',
		{ timeout: 30_000 },
		async () => {
			const { lab, store, projectId, dir } = setup();
			const id = store.importFile(projectId, 'Bracket', writeStl(await cube(20)), 'stl');
			await store.op(id, { op: 'scale', factor: [0.5, 0.5, 0.5] });
			const detail = store.detail(id);
			expect(detail.versions).toHaveLength(2);
			expect(Math.round(detail.current!.sizeX)).toBe(10);
			const jobId = lab.createJob({ projectId, modelVersionId: detail.current!.id });
			expect(() => store.saveThumbnail(id, detail.current!.id, Buffer.from('not png'))).toThrow(
				/PNG/
			);
			store.remove(id);
			expect(fs.existsSync(path.join(dir, id))).toBe(false);
			expect(lab.snapshot().jobs.find((j) => j.id === jobId)!.modelVersionId).toBeNull();
			const parametric = await store.createParametric(projectId, 'Box');
			await expect(store.op(parametric, { op: 'center' })).rejects.toMatchObject({ status: 400 });
			const copy = store.meshCopy(parametric);
			expect(store.model(copy).kind).toBe('mesh');
		}
	);
});

describe('Blender sessions', () => {
	it(
		'imports a save made just before Blender quits, then ends the session',
		{ timeout: 30_000 },
		async () => {
			const dir = tmpdir();
			// A stand-in for Blender: "saves" once (copies the input to the export path) and quits at once.
			const fake = path.join(dir, 'blender');
			fs.writeFileSync(
				fake,
				`#!/usr/bin/env node
const fs = require('fs');
const [input, out] = process.argv.slice(process.argv.indexOf('--') + 1);
setTimeout(() => fs.copyFileSync(input, out), 200);
setTimeout(() => process.exit(0), 250);
`,
				{ mode: 0o755 }
			);
			const previous = process.env.BLENDER_PATH;
			process.env.BLENDER_PATH = fake;
			try {
				const db = openDatabase(':memory:');
				const lab = new Lab(db);
				const store = new ModelStore(db, lab, path.join(dir, 'models'));
				const projectId = lab.createProject({
					profileId: lab.createProfile({ name: 'Sam', color: 'blue' }),
					title: 'Hooks'
				});
				const id = store.importFile(projectId, 'Hook', writeStl(await cube(10)), 'stl');
				store.openInBlender(id);
				expect(store.detail(id).editing).toBe(true);
				await expect.poll(() => store.detail(id).editing, { timeout: 10_000 }).toBe(false);
				const detail = store.detail(id);
				expect(detail.versions.map((v) => v.note)).toEqual(['Saved from Blender', 'Imported STL']);
				// The session remembers which version its .blend belongs to.
				expect(fs.readFileSync(path.join(dir, 'models', id, 'blender', 'source.txt'), 'utf8')).toBe(
					store.path(id, detail.current!.id)
				);
			} finally {
				if (previous === undefined) delete process.env.BLENDER_PATH;
				else process.env.BLENDER_PATH = previous;
			}
		}
	);
});

// Opens a real Blender window, so it only runs when asked: FPL_BLENDER_GUI_TEST=1 npm run test:unit
describe.runIf(process.env.FPL_BLENDER_GUI_TEST && findBlender())('real Blender window', () => {
	it(
		'loads the part, and a save in Blender comes back as a new version',
		{ timeout: 120_000 },
		async () => {
			const dir = tmpdir();
			const previous = process.env.FPL_SELFTEST;
			process.env.FPL_SELFTEST = '1'; // the session scales the part to 150 %, saves, and quits
			try {
				const db = openDatabase(':memory:');
				const lab = new Lab(db);
				const store = new ModelStore(db, lab, path.join(dir, 'models'));
				const projectId = lab.createProject({
					profileId: lab.createProfile({ name: 'Sam', color: 'blue' }),
					title: 'Hooks'
				});
				const id = store.importFile(projectId, 'Hook', writeStl(await cube(20)), 'stl');
				store.openInBlender(id);
				await expect
					.poll(() => store.detail(id).editing, { timeout: 100_000, interval: 1000 })
					.toBe(false);
				const current = store.detail(id).current!;
				expect(current.note).toBe('Saved from Blender');
				expect(current.sizeX).toBeCloseTo(30, 1);
			} finally {
				if (previous === undefined) delete process.env.FPL_SELFTEST;
				else process.env.FPL_SELFTEST = previous;
			}
		}
	);
});

describe('AI-assisted design', () => {
	it(
		'compiles each attempt and feeds errors back until the part renders',
		{ timeout: 30_000 },
		async () => {
			const prompts: string[] = [];
			const replies = [
				{ name: 'Clip', summary: 'A clip', source: 'cube([10, 10, 5]' },
				{
					summary: 'Fixed the missing bracket',
					source: 'width = 12; // [5:1:40]\ncube([width, 10, 5]);'
				}
			];
			const fake: Provider = {
				id: 'claude-code',
				status: async () => ({ id: 'claude-code', label: '', available: true, detail: '' }),
				structured: async <T>(req: { prompt: string }) => {
					prompts.push(req.prompt);
					return replies.shift() as T;
				},
				chat: async () => {}
			};
			const result = await designPart(fake, {
				prompt: 'a small cable clip',
				projectTitle: 'Desk',
				projectDescription: ''
			});
			expect(result.attempts).toBe(2);
			expect(result.render.ok).toBe(true);
			expect(result.name).toBe('Clip');
			expect(prompts[1]).toMatch(/does not render/);
			expect(prompts[1]).toMatch(/line 1/);
		}
	);
});
