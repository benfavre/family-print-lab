import { describe, expect, it } from 'vitest';
import { TAB_GROUPS } from '$lib/server/profiles/groups.generated';
import { bake, compose as cliCompose, plateOrigin as cliPlateOrigin } from '$lib/server/slicer/cli';
import {
	decodePaint,
	encodePaint,
	paintTriangle,
	PAINT_BLOCKER,
	PAINT_ENFORCER
} from '$lib/shared/slicer/paint';
import {
	emptyProject,
	IDENTITY,
	type MeshRef,
	type Project,
	type Transform
} from '$lib/shared/slicer/project';
import type { BedShape, PlateResult } from '$lib/shared/slicer-ui';
import {
	applyPoint,
	boundsOf,
	compose,
	decompose,
	dropToBed,
	faceNormal,
	invert,
	layOnFace,
	recompose,
	rotateAbout,
	snap,
	translation
} from './matrix';
import { plateAt, plateCentre, plateColumns, plateOf, plateOrigin } from './plates';
import {
	addHeightRange,
	addObject,
	addPart,
	addPlate,
	applyArrange,
	duplicateObjects,
	freshId,
	heightRangeProblems,
	instanceBox,
	objectFilament,
	outsidePlate,
	partFilament,
	placeInstance,
	removeObjects,
	removePart,
	removePlate,
	setConfig,
	setFilaments
} from './edit';
import { History } from './history';
import {
	clickPick,
	EMPTY_SELECTION,
	pickPart,
	pruneSelection,
	selectPlate,
	selectedPlates
} from './selection';
import { OBJECT_SETTINGS, RANGE_KEYS, addableSettings, groupConfig, settingDef } from './settings';
import { binaryStl, primitiveSoup } from './primitives';
import {
	adjacency,
	brushTriangles,
	fillTriangles,
	paintCounts,
	paintWith,
	shownStates
} from './paint';
import { colourDistance, slotFromTray, suggestTrays, type TrayChoice } from './trays';
import { filamentRows, objectRows, plateResult, totalGrams } from './results';
import { parseStl } from '../stl';

const BED: BedShape = { area: [0, 0, 256, 256], height: 250, printerModel: 'Bambu Lab P1S' };
const close = (a: number[], b: number[], eps = 1e-6) =>
	expect(a.every((v, i) => Math.abs(v - b[i]) < eps)).toBe(true);

const presets = {
	printer: { kind: 'printer' as const, name: 'P', source: 'system' as const },
	process: { kind: 'process' as const, name: 'Q', source: 'system' as const },
	filaments: [{ kind: 'filament' as const, name: 'F', source: 'system' as const }]
};
const mesh = (id: string, size = 20): MeshRef => ({
	id: id.repeat(64).slice(0, 64),
	triangles: 12,
	vertices: 8,
	bbox: [0, 0, 0, size, size, size / 2],
	storage: { kind: 'file', path: '/x.stl' }
});
const cube = (size = 20) => primitiveSoup('box', [size, size, size]);

describe('transforms', () => {
	it('composes like the command line backend bakes them (part, then instance)', () => {
		const part: Transform = [0, 1, 0, -1, 0, 0, 0, 0, 1, 5, 0, 0];
		const inst = translation(100, 50, 2);
		expect(compose(part, inst)).toEqual(cliCompose(part, inst));
		const p = applyPoint(compose(part, inst), [1, 0, 0]);
		close(p, [105, 51, 2]);
		close(compose(inst, invert(inst)), IDENTITY);
	});

	it('splits into position, rotation and scale and back', () => {
		const t = recompose({ position: [10, 20, 3], rotation: [0, 0, 90], scale: [2, 1, 1] });
		const d = decompose(t);
		close(d.position, [10, 20, 3]);
		close(d.rotation, [0, 0, 90]);
		close(d.scale, [2, 1, 1]);
		// A point on +X, scaled then turned a quarter about Z, ends up on +Y.
		close(applyPoint(t, [1, 0, 0]), [10, 22, 3]);
	});

	it('drops to the bed, turns about a point and lays a face flat', () => {
		const soup = cube(10);
		const lifted = translation(0, 0, 7);
		const b = boundsOf(soup, lifted);
		expect(b[2]).toBeCloseTo(2);
		expect(boundsOf(soup, dropToBed(lifted, b[2]))[2]).toBeCloseTo(0);
		const turned = rotateAbout(IDENTITY, [0, 0, 1], 90, [5, 0, 0]);
		close(applyPoint(turned, [5, 0, 0]), [5, 0, 0]);
		close(applyPoint(turned, [6, 0, 0]), [5, 1, 0]);
		// The top face (normal +Z) laid on the bed points down afterwards.
		const top = [...Array(soup.length / 9).keys()].find(
			(t) => faceNormal(soup, t, IDENTITY)[2] > 0.99
		)!;
		const flat = layOnFace(IDENTITY, faceNormal(soup, top, IDENTITY), [0, 0, 0]);
		close(faceNormal(soup, top, flat), [0, 0, -1]);
	});

	it('snaps', () => {
		expect(snap(12.3, 5)).toBe(10);
		expect(snap(12.3, 0)).toBe(12.3);
		expect(snap(0.26, 0.1)).toBe(0.3);
	});
});

describe('plates', () => {
	it('lays plates out like Bambu Studio and the command line backend', () => {
		expect([1, 2, 3, 4, 5, 10].map(plateColumns)).toEqual([1, 2, 2, 2, 3, 4]);
		for (const count of [1, 2, 5, 9])
			for (let i = 1; i <= count; i++)
				expect(plateOrigin(BED, count, i)).toEqual(
					cliPlateOrigin(['0x0', '256x0', '256x256', '0x256'], count, i)
				);
		expect(plateCentre(BED, 2, 2)).toEqual([256 * 1.2 + 128, 128]);
		expect(plateAt(BED, 2, 128, 128)).toBe(1);
		expect(plateAt(BED, 2, 256 * 1.2 + 10, 10)).toBe(2);
		expect(plateAt(BED, 2, 128, 900)).toBeNull();
	});
});

describe('editing a project', () => {
	function start(): Project {
		const p = emptyProject(presets);
		addObject(p, { name: 'Cube', mesh: mesh('a'), plate: 1, bed: BED });
		return p;
	}

	it('adds an object centred on its plate, resting on the bed', () => {
		const p = start();
		expect(p.objects[0]).toMatchObject({ id: 'o1', parts: [{ id: 'o1-p1', type: 'model' }] });
		expect(p.plates[0].instances).toEqual([{ objectId: 'o1', instanceId: 'o1-i1' }]);
		expect(instanceBox(p, p.objects[0], p.objects[0].instances[0].transform)).toEqual([
			118, 118, 0, 138, 138, 10
		]);
		expect(freshId('o', ['o1', 'o2'])).toBe('o3');
	});

	it('adds and removes plates, moving objects with their plate', () => {
		const p = start();
		addPlate(p, BED);
		const second = addObject(p, { name: 'Two', mesh: mesh('b'), plate: 2, bed: BED });
		addPlate(p, BED);
		const third = addObject(p, { name: 'Three', mesh: mesh('c'), plate: 3, bed: BED });
		// Three plates: two columns, plate 3 below plate 1.
		expect(instanceBox(p, third, third.instances[0].transform).slice(0, 2)).toEqual([
			118,
			118 - 256 * 1.2
		]);
		removePlate(p, BED, 2);
		expect(p.plates.map((x) => x.index)).toEqual([1, 2]);
		expect(p.objects.map((o) => o.id)).toEqual(['o1', third.id]);
		expect(p.objects.find((o) => o.id === second.id)).toBeUndefined();
		// The old plate 3 is plate 2 now, one plate to the right of plate 1, and its object came along.
		expect(plateOf(p, third.id, third.instances[0].id)).toBe(2);
		expect(instanceBox(p, third, third.instances[0].transform).slice(0, 2)).toEqual([
			118 + 256 * 1.2,
			118
		]);
		expect(() => {
			removePlate(p, BED, 1);
			removePlate(p, BED, 1);
		}).toThrow(/at least one plate/);
	});

	it('moves an instance to the plate it is dragged onto', () => {
		const p = start();
		addPlate(p, BED);
		placeInstance(p, BED, 'o1', 'o1-i1', translation(256 * 1.2 + 50, 50, 0));
		expect(plateOf(p, 'o1', 'o1-i1')).toBe(2);
		expect(p.plates[0].instances).toEqual([]);
		placeInstance(p, BED, 'o1', 'o1-i1', translation(5000, 5000, 0));
		expect(plateOf(p, 'o1', 'o1-i1')).toBe(2);
	});

	it('copies objects as new ones and deletes them with unused meshes', () => {
		const p = start();
		p.objects[0].sourceId = 7;
		p.objects[0].parts[0].uuid = 'u';
		p.objects[0].config.wall_loops = '4';
		const [id] = duplicateObjects(p, ['o1']);
		const copy = p.objects.find((o) => o.id === id)!;
		expect(copy.sourceId).toBeUndefined();
		expect(copy.parts[0].uuid).toBeUndefined();
		expect(copy.config.wall_loops).toBe('4');
		expect(copy.instances[0].transform[9]).toBe(p.objects[0].instances[0].transform[9] + 30);
		expect(p.plates[0].instances).toHaveLength(2);
		copy.config.wall_loops = '2';
		expect(p.objects[0].config.wall_loops).toBe('4');
		removeObjects(p, ['o1', id]);
		expect(p.objects).toEqual([]);
		expect(p.meshes).toEqual({});
	});

	it('adds modifiers in the middle of the object and keeps one model part', () => {
		const p = start();
		const box = { ...mesh('d'), bbox: [-2, -2, -2, 2, 2, 2] as MeshRef['bbox'] };
		const part = addPart(p, 'o1', {
			name: 'Box',
			type: 'modifier',
			mesh: box,
			primitive: { kind: 'box', size: [4, 4, 4] }
		});
		expect(part.transform.slice(9)).toEqual([10, 10, 5]);
		expect(p.meshes[box.id]).toBe(box);
		expect(() => removePart(p, 'o1', 'o1-p1')).toThrow(/at least one part/);
		removePart(p, 'o1', part.id);
		expect(p.meshes[box.id]).toBeUndefined();
	});

	it('keeps settings, height ranges and filaments tidy', () => {
		const p = start();
		const obj = p.objects[0];
		setConfig(obj.config, 'wall_loops', '3');
		setConfig(obj.config, 'wall_loops', '');
		expect(obj.config).toEqual({});
		addHeightRange(obj, 10);
		addHeightRange(obj, 10);
		expect(obj.heightRanges.map((r) => [r.minZ, r.maxZ])).toEqual([
			[0, 2],
			[2, 4]
		]);
		expect(heightRangeProblems(obj)).toEqual([]);
		obj.heightRanges[1].minZ = 1;
		expect(heightRangeProblems(obj)[0]).toMatch(/overlap/);
		obj.config.extruder = '3';
		obj.parts[0].filament = 2;
		expect(objectFilament(obj)).toBe(3);
		expect(partFilament(obj, obj.parts[0])).toBe(2);
		setFilaments(p, [{ index: 9, preset: presets.filaments[0], color: '#FF0000', type: 'PLA' }]);
		expect(p.presets.filaments).toEqual([presets.filaments[0]]);
		expect(p.filaments[0].index).toBe(1);
		expect(obj.config.extruder).toBe('1');
		expect(obj.parts[0].filament).toBe(1);
	});

	it('applies an arrangement and says what does not fit', () => {
		const p = start();
		addPlate(p, BED);
		applyArrange(p, {
			instances: [
				{ objectId: 'o1', instanceId: 'o1-i1', plate: 2, transform: translation(400, 10, 0) }
			]
		});
		expect(plateOf(p, 'o1', 'o1-i1')).toBe(2);
		expect(outsidePlate(p, BED)).toEqual([]);
		p.objects[0].instances[0].transform = translation(250, 10, 0);
		expect(outsidePlate(p, BED)).toEqual(['Cube does not fit on plate 2.']);
		p.objects[0].instances[0].transform = translation(400, 10, -1);
		expect(outsidePlate(p, BED)).toEqual(['Cube goes below the bed on plate 2.']);
	});
});

describe('undo and selection', () => {
	it('undoes and redoes snapshots with labels', () => {
		const h = new History<number>(2);
		h.push('one', 1);
		h.push('two', 2);
		h.push('three', 3);
		expect(h.undoLabel).toBe('three');
		expect(h.undo(4)).toEqual({ label: 'three', state: 3 });
		expect(h.redo(3)).toEqual({ label: 'three', state: 4 });
		expect(h.undo(4)?.state).toBe(3);
		expect(h.undo(3)?.state).toBe(2);
		expect(h.undo(2)).toBeNull();
		h.push('new', 5);
		expect(h.redoLabel).toBeNull();
	});

	it('selects instances, parts and plates, and forgets what is gone', () => {
		const p = emptyProject(presets);
		addObject(p, { name: 'A', mesh: mesh('a'), plate: 1, bed: BED });
		addObject(p, { name: 'B', mesh: mesh('b'), plate: 1, bed: BED });
		const a = { objectId: 'o1', instanceId: 'o1-i1' };
		const b = { objectId: 'o2', instanceId: 'o2-i1' };
		let sel = clickPick(EMPTY_SELECTION, a, false);
		sel = clickPick(sel, b, true);
		expect(sel.items).toEqual([a, b]);
		expect(clickPick(sel, a, true).items).toEqual([b]);
		expect(clickPick(sel, null, false)).toEqual(EMPTY_SELECTION);
		expect(selectPlate(p, 1).items).toEqual([a, b]);
		expect(pickPart(p, 'o1', 'o1-p1')).toEqual({ items: [a], partId: 'o1-p1' });
		expect(selectedPlates(p, sel)).toEqual([1]);
		removeObjects(p, ['o2']);
		expect(pruneSelection(p, sel).items).toEqual([a]);
	});
});

describe('object settings', () => {
	it('only offers keys Bambu Studio has on its process tabs', () => {
		const process = new Set(TAB_GROUPS.process.flatMap((p) => p.groups.flatMap((g) => g.keys)));
		for (const g of OBJECT_SETTINGS) {
			expect(TAB_GROUPS.process.map((p) => p.page)).toContain(g.page);
			for (const s of g.settings) expect(process.has(s.key), s.key).toBe(true);
		}
		for (const k of RANGE_KEYS) expect(process.has(k), k).toBe(true);
	});

	it('groups a config map and lists what can still be added', () => {
		const groups = groupConfig({ sparse_infill_density: '30%', extruder: '2', my_key: '1' });
		expect(groups).toEqual([
			{ page: 'Strength', keys: [settingDef('sparse_infill_density')] },
			{ page: 'Others', keys: [{ key: 'my_key', label: 'my key', kind: 'text' }] }
		]);
		const addable = addableSettings({ sparse_infill_density: '30%' });
		expect(addable.flatMap((g) => g.settings.map((s) => s.key))).not.toContain(
			'sparse_infill_density'
		);
	});
});

describe('modifier shapes', () => {
	it('makes closed shapes of the asked size that read back as STL', () => {
		for (const kind of ['box', 'cylinder', 'sphere'] as const) {
			const soup = primitiveSoup(kind, [10, 20, 30]);
			const b = boundsOf(soup);
			close(b, [-5, -10, -15, 5, 10, 15], 1e-4);
			// Closed: every edge has exactly one neighbour across it.
			expect(adjacency(soup).every((n) => n.length === 3)).toBe(true);
			// Outward: the signed volume is positive.
			let vol = 0;
			for (let i = 0; i < soup.length; i += 9)
				vol +=
					(soup[i] * (soup[i + 4] * soup[i + 8] - soup[i + 5] * soup[i + 7]) -
						soup[i + 1] * (soup[i + 3] * soup[i + 8] - soup[i + 5] * soup[i + 6]) +
						soup[i + 2] * (soup[i + 3] * soup[i + 7] - soup[i + 4] * soup[i + 6])) /
					6;
			expect(vol).toBeGreaterThan(0);
			expect(parseStl(binaryStl(soup))).toEqual(soup);
		}
	});
});

describe('painting', () => {
	const soup = cube(10);
	const top = [...Array(soup.length / 9).keys()].filter(
		(t) => faceNormal(soup, t, IDENTITY)[2] > 0.99
	);

	it('brushes triangles near a point and fills faces up to their edges', () => {
		const n = adjacency(soup);
		expect(brushTriangles(soup, top[0], [0, 0, 5], 0.5)).toEqual([top[0]]);
		expect(brushTriangles(soup, top[0], [0, 0, 5], 20)).toHaveLength(12);
		// Smart fill stops at the cube's edges: only the top face's two triangles.
		expect(fillTriangles(soup, n, top[0], 30).sort()).toEqual([...top].sort());
		// Plain fill spreads over everything painted alike.
		expect(fillTriangles(soup, n, top[0], null)).toHaveLength(12);
		// …but not into triangles painted differently.
		const states = new Map([[top[1], PAINT_ENFORCER]]);
		expect(fillTriangles(soup, n, top[0], null, (t) => states.get(t) ?? 0)).toHaveLength(11);
	});

	it('paints whole triangles in the 3MF encoding and clears them again', () => {
		let paint = paintWith({}, 'supports', [1, 2], PAINT_ENFORCER);
		expect(paint).toEqual({
			supports: { 1: paintTriangle(PAINT_ENFORCER), 2: paintTriangle(PAINT_ENFORCER) }
		});
		paint = paintWith({ paint }, 'seam', [3], PAINT_BLOCKER);
		expect(decodePaint(paint!.seam![3])).toEqual({ state: PAINT_BLOCKER });
		expect(paintCounts({ paint })).toEqual({ supports: 2, seam: 1 });
		paint = paintWith({ paint }, 'supports', [1, 2], 0);
		paint = paintWith({ paint }, 'seam', [3], 0);
		expect(paint).toBeUndefined();
	});

	it('shows split triangles by the state they use', () => {
		const split = encodePaint({
			split: 1,
			special: 0,
			children: [{ state: 0 }, { state: 2 }]
		});
		expect(shownStates({ 4: paintTriangle(1), 5: split, 6: 'zz' })).toEqual(
			new Map([
				[4, 1],
				[5, 2]
			])
		);
	});
});

describe('trays', () => {
	const tray = (index: number, type: string, color: string): TrayChoice => ({
		index,
		label: `A${index + 1}`,
		type,
		name: type,
		color,
		remain: null
	});
	it('suggests the nearest colour of the same material, each tray once', () => {
		const slot = (type: string, color: string) => ({
			index: 1,
			preset: presets.filaments[0],
			type,
			color
		});
		const trays = [
			tray(0, 'PLA', '#FFFFFF'),
			tray(1, 'PLA', '#FF0000'),
			tray(2, 'PETG', '#FF0000')
		];
		expect(
			suggestTrays(
				[
					slot('PLA', '#EE1111'),
					slot('PLA', '#EE1111'),
					slot('PETG', '#000000'),
					slot('ABS', '#000000')
				],
				trays
			)
		).toEqual([1, 0, 2, null]);
		expect(colourDistance('#000000', '#000000')).toBe(0);
		expect(slotFromTray(slot('PLA', '#FFFFFF'), tray(3, 'PLA', 'FF7A2FFF'))).toMatchObject({
			tray: 3,
			color: '#FF7A2F',
			type: 'PLA'
		});
	});
});

describe('results', () => {
	const project = emptyProject(presets);
	addObject(project, { name: 'Cube', mesh: mesh('a'), plate: 1, bed: BED });
	project.filaments[0].color = '#FF0000';
	const result: PlateResult = {
		plate: 1,
		revision: 3,
		stats: {
			plate: 1,
			seconds: 1200,
			layers: 50,
			filaments: [
				{ index: 1, grams: 4.26, meters: 1.4 },
				{ index: 2, grams: 0, meters: 0 }
			],
			objects: [{ objectId: 'o1', seconds: 600, grams: 2.04 }],
			warnings: []
		},
		sliced: {
			index: 1,
			gcode: 'Metadata/plate_1.gcode',
			md5: '',
			minutes: 20,
			grams: 4.3,
			layers: 50,
			supports: false,
			filaments: []
		},
		backend: 'printlab-slicer',
		printerModelId: 'C12',
		preview: true,
		at: ''
	};
	it('marks results of an older save as stale and breaks them down', () => {
		expect(plateResult({ revision: 3, results: [result] }, 1, 3)?.stale).toBe(false);
		expect(plateResult({ revision: 4, results: [result] }, 1, 4)?.stale).toBe(true);
		expect(plateResult({ revision: 3, results: [result] }, 2, 3)).toBeNull();
		expect(totalGrams(result)).toBe(4.3);
		expect(objectRows(project, result)).toEqual([
			{ objectId: 'o1', name: 'Cube', seconds: 600, grams: 2, share: 0.5 }
		]);
		expect(filamentRows(project, result)).toEqual([
			{ index: 1, color: '#FF0000', type: 'PLA', grams: 4.3, meters: 1.4 }
		]);
	});
});

describe('the scene matches what the backends slice', () => {
	it('bakes a part like the command line does', () => {
		const soup = cube(10);
		const part: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 5];
		const inst = recompose({ position: [100, 100, 0], rotation: [0, 0, 45], scale: [1, 1, 1] });
		close(
			[...boundsOf(soup, compose(part, inst))],
			[...boundsOf(bake(soup, cliCompose(part, inst)))],
			1e-4
		);
	});
});
