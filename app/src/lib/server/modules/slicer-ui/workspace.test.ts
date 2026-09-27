import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestLab, type TestLab } from '../../testing/harness';
import { writeStl } from '../../cad/mesh';
import { renderScad } from '../../cad/openscad';
import { readSliced } from '../../printer/sliced';
import { read3mf } from '../../slicer3mf/read';
import * as locations from '../../slicer/locate';
import { fakeInstall, type FakeInstall } from '../../slicer/__fixtures__/install';
import { decodePreview } from '$lib/shared/slicer/preview';
import { paintTriangle, PAINT_ENFORCER } from '$lib/shared/slicer/paint';
import type { Project } from '$lib/shared/slicer/project';
import type { SliceProgress } from '$lib/shared/slicer-ui';
import { asResolvable, bedFromConfig, modelCodeOf, selectionReady } from './workspace';

describe('workspace helpers', () => {
	it('reads the bed from printable_area and printable_height', () => {
		expect(
			bedFromConfig({
				printable_area: ['0x0', '180x0', '180x180', '0x180'],
				printable_height: '180',
				printer_model: 'Bambu Lab A1 mini'
			})
		).toEqual({ area: [0, 0, 180, 180], height: 180, printerModel: 'Bambu Lab A1 mini' });
		expect(bedFromConfig({})).toEqual({ area: [0, 0, 256, 256], height: 250, printerModel: '' });
	});

	it('looks up presets named in a project file among the system presets', () => {
		expect(
			asResolvable({ kind: 'process', name: '0.20mm Standard @BBL X1C', source: 'project' })
		).toEqual({ kind: 'process', name: '0.20mm Standard @BBL X1C', source: 'system' });
		const user = {
			kind: 'filament' as const,
			name: 'Mine',
			source: 'user' as const,
			userPresetId: 'u1'
		};
		expect(asResolvable(user)).toBe(user);
	});

	it('says which preset is missing', () => {
		const ref = (kind: 'printer' | 'process' | 'filament', name: string) => ({
			kind,
			name,
			source: 'system' as const
		});
		expect(
			selectionReady({ printer: ref('printer', ''), process: ref('process', 'p'), filaments: [] })
		).toBe('Choose a printer preset first.');
		expect(
			selectionReady({ printer: ref('printer', 'a'), process: ref('process', 'p'), filaments: [] })
		).toBe('Choose a filament for every slot first.');
		expect(
			selectionReady({
				printer: ref('printer', 'a'),
				process: ref('process', 'p'),
				filaments: [ref('filament', 'f')]
			})
		).toBeNull();
	});

	it('maps printer_model to the catalogue code', () => {
		expect(modelCodeOf('Bambu Lab P1S')).toBe('C12');
		expect(modelCodeOf('Something else')).toBeNull();
	});
});

// The fake install's presets (slicer/__fixtures__/install.ts), as the preset pickers choose them.
const P1S = {
	printer: {
		kind: 'printer' as const,
		name: 'Bambu Lab P1S 0.4 nozzle',
		source: 'system' as const
	},
	process: {
		kind: 'process' as const,
		name: '0.20mm Standard @BBL P1S',
		source: 'system' as const
	},
	filaments: [
		{ kind: 'filament' as const, name: 'Bambu PLA Basic @BBL P1S', source: 'system' as const }
	]
};

describe('the slicer workspace against the Bambu Studio command line', () => {
	let install: FakeInstall;
	let t: TestLab;
	beforeAll(() => {
		install = fakeInstall();
	});
	afterAll(() => install.remove());
	afterEach(async () => {
		await t?.stop();
		vi.restoreAllMocks();
	});

	async function until<T>(get: () => T | undefined, ms = 15_000): Promise<T> {
		const end = Date.now() + ms;
		for (;;) {
			const v = get();
			if (v) return v;
			if (Date.now() > end) throw new Error('Timed out');
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	async function setUp(modules: string[]) {
		// The fake command line and its presets are the backend under test here.
		vi.spyOn(locations, 'locateEngine').mockReturnValue(null);
		t = await startTestLab({
			fleet: ['C12'],
			modules,
			speed: 1200,
			env: { BAMBU_STUDIO_PATH: install.bin }
		});
		const { lab, models } = t.rt;
		const profileId = lab.createProfile({ name: 'Alex', color: 'blue' });
		const projectId = lab.createProject({ profileId, title: 'Desk tidy' });
		const cube = await renderScad('cube([20, 20, 10]);');
		const modelId = models.importFile(projectId, 'Tray', writeStl(cube.soup!), 'stl');
		const versionId = models.detail(modelId).current!.id;
		const store = t.rt.module('slicer-3mf')!;
		const summary = store.createFromModels(projectId, 'Desk tidy', [{ modelId, versionId }]);
		return { projectId, store, summary, workspace: t.rt.module('slicer-ui')! };
	}

	it('builds two plates with a modifier and painted supports, slices plate 2, previews it, sends it to the simulated P1S and round-trips the project file', async () => {
		const { store, summary, workspace } = await setUp([
			'slicer-3mf',
			'slicer-engine',
			'slicer-profiles',
			'queue',
			'slicer-ui'
		]);
		const info = await workspace.info();
		expect(info).toMatchObject({ engine: 'bambu-studio-cli', queue: true, profiles: true });
		expect(info.capabilities).toContain('slice');

		// The browser's edits: presets for the P1S, a second plate with a copy, a modifier, painting.
		const project: Project = structuredClone(await store.load(summary.id));
		project.presets = P1S;
		project.filaments = project.presets.filaments.map((preset, i) => ({
			index: i + 1,
			preset,
			color: '#FF7A2F',
			type: 'PLA'
		}));
		const bed = workspace.bed(project.presets.printer);
		expect(bed.area).toEqual([0, 0, 256, 256]);
		const obj = project.objects[0];
		const copy = structuredClone(obj);
		copy.id = 'o2';
		copy.name = 'Tray copy';
		copy.parts = copy.parts.map((p) => ({ ...p, id: `o2-${p.id}` }));
		copy.instances = [{ ...copy.instances[0], id: 'o2-i1' }];
		// Plate 2 sits 1.2 beds to the right (PartPlate.cpp LOGICAL_PART_PLATE_GAP): same spot on it.
		copy.instances[0].transform[9] += 256 * 1.2;
		project.objects.push(copy);
		project.plates.push({
			index: 2,
			name: 'Second',
			locked: false,
			instances: [{ objectId: 'o2', instanceId: 'o2-i1' }],
			config: {},
			bedType: 'Textured PEI Plate'
		});
		const box = await renderScad('cube([5, 5, 5], center = true);');
		const modifier = store.putMesh(box.soup!);
		copy.parts.push({
			id: 'o2-m1',
			name: 'Box modifier',
			type: 'modifier',
			mesh: modifier.id,
			transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 10, 5],
			config: { sparse_infill_density: '60%' },
			primitive: { kind: 'box', size: [5, 5, 5] }
		});
		copy.parts[0].paint = {
			supports: { 0: paintTriangle(PAINT_ENFORCER), 3: paintTriangle(PAINT_ENFORCER) }
		};
		const saved = store.saveSync(summary.id, project, summary.revision);

		const progress: SliceProgress[] = [];
		t.rt.live.on('live', (m: { channel: string; data: SliceProgress }) => {
			if (m.channel === 'slicer-ui:progress') progress.push(m.data);
		});
		expect(() => workspace.slice(summary.id, { plate: 2, revision: saved.revision - 1 })).toThrow(
			/changed on the server/
		);
		const task = workspace.slice(summary.id, { plate: 2, revision: saved.revision });
		expect(() => workspace.slice(summary.id, { plate: 2 })).toThrow(/slicing already/);
		// A reloaded page finds the running slice again.
		expect(workspace.results(summary.id).slicing).toEqual([{ plate: 2, taskId: task.id }]);
		const done = await until(() =>
			t.rt.tasks.list().find((x) => x.id === task.id && x.status !== 'running')
		);
		expect(done.error).toBeNull();
		expect(done).toMatchObject({ status: 'done', kind: 'slice' });
		expect(progress.length).toBeGreaterThan(0);
		expect(progress.every((p) => p.slicerProjectId === summary.id && p.plate === 2)).toBe(true);

		const { results, revision, slicing } = workspace.results(summary.id);
		expect(revision).toBe(saved.revision);
		expect(slicing).toEqual([]);
		expect(results).toHaveLength(1);
		const result = results[0];
		expect(result).toMatchObject({
			plate: 2,
			revision,
			backend: 'bambu-studio-cli',
			printerModelId: 'C12'
		});
		// The command line cannot take modifiers or painting: it says so rather than hiding it.
		expect(result.stats.warnings.map((w) => w.code)).toEqual(
			expect.arrayContaining(['CLI_PART_IGNORED', 'CLI_SETTINGS_IGNORED'])
		);
		expect(result.preview).toBe(true);
		const preview = decodePreview(workspace.preview(summary.id, 2));
		// The fake command line writes a G-code without moves; the container is still a real one.
		expect(preview.header.source).toBe('gcode');

		// Plate 2 goes to the simulated P1S through a new job (the send window's direct send).
		const p1s = t.printer('C12');
		const sent = workspace.send(summary.id, { plate: 2, printerId: p1s.info.id, queue: false });
		expect(sent.queued).toBe(false);
		const job = t.rt.lab.getJob(sent.jobId)!;
		expect(job).toMatchObject({ status: 'Queued', printerId: p1s.info.id });
		expect(job.sliced).toMatchObject({ source: 'app', printerModelId: 'C12' });
		expect(job.sliced!.name).toBe('Desk tidy plate 2.gcode.3mf');
		const finished = t.nextEvent('print.finished', (e) => e.printerId === p1s.info.id, 20_000);
		t.rt.printing.send(sent.jobId, { printerId: p1s.info.id, useAms: false, amsMapping: [] });
		await finished;
		expect(t.rt.lab.getJob(sent.jobId)).toMatchObject({ status: 'Succeeded' });

		// "Open in Bambu Studio": the project file reads back with both plates, the modifier and the painting.
		const file = read3mf(fs.readFileSync(store.file(summary.id).path)).project;
		expect(file.plates.map((p) => p.index)).toEqual([1, 2]);
		const back = file.objects.find((o) => o.name === 'Tray copy')!;
		expect(back.parts.map((p) => p.type)).toEqual(['model', 'modifier']);
		expect(back.parts[1].config.sparse_infill_density).toBe('60%');
		expect(back.parts[0].paint?.supports?.[3]).toBe(paintTriangle(PAINT_ENFORCER));
		expect(file.presets.printer.name).toBe(project.presets.printer.name);

		// A later save makes the result stale: no sending an outdated plate.
		store.saveSync(summary.id, project);
		expect(() => workspace.send(summary.id, { plate: 2, printerId: null, queue: false })).toThrow(
			/changed since plate 2/
		);
	}, 60_000);

	it('arranges and orients with the backend, and queues a sliced plate', async () => {
		const { store, summary, workspace } = await setUp([
			'slicer-3mf',
			'slicer-engine',
			'slicer-profiles',
			'queue',
			'slicer-ui'
		]);
		const project = structuredClone(await store.load(summary.id));
		project.presets = P1S;
		const saved = store.saveSync(summary.id, project);

		const arranged = await workspace.arrange(summary.id, { plate: 1, revision: saved.revision });
		expect(arranged.instances).toHaveLength(1);
		expect(arranged.instances[0]).toMatchObject({ objectId: 'o1', instanceId: 'o1-i1', plate: 1 });
		const oriented = await workspace.orient(summary.id, { objectIds: ['o1', 'nope'] });
		expect(oriented.objects.map((o) => o.objectId)).toEqual(['o1']);
		await expect(workspace.orient(summary.id, { objectIds: ['nope'] })).rejects.toThrow(
			/Choose the objects/
		);

		const task = workspace.slice(summary.id, { plate: 1 });
		await until(() => t.rt.tasks.list().find((x) => x.id === task.id && x.status === 'done'));
		const sent = workspace.send(summary.id, { plate: 1, printerId: null, queue: true });
		expect(sent.queued).toBe(true);
		const queue = t.rt.module('queue')!;
		expect(queue.list().items.map((i) => i.jobId)).toContain(sent.jobId);
		expect(
			readSliced(fs.readFileSync(t.rt.printing.file(t.rt.lab.getJob(sent.jobId)!.sliced!.file)))
				.plates
		).toHaveLength(1);
	}, 60_000);

	it('says what is missing: no presets, an empty plate, no queue', async () => {
		const { store, summary, workspace } = await setUp(['slicer-3mf', 'slicer-engine', 'slicer-ui']);
		const info = await workspace.info();
		expect(info).toMatchObject({ queue: false, profiles: false });
		expect(workspace.bed({ kind: 'printer', name: '', source: 'system' }).area).toEqual([
			0, 0, 256, 256
		]);
		// Created from models without presets: slicing asks for them first.
		const task = workspace.slice(summary.id, { plate: 1 });
		const failed = await until(() =>
			t.rt.tasks.list().find((x) => x.id === task.id && x.status !== 'running')
		);
		expect(failed).toMatchObject({ status: 'failed', error: 'Choose a printer preset first.' });
		const project = structuredClone(await store.load(summary.id));
		project.plates.push({ index: 2, name: '', locked: false, instances: [], config: {} });
		store.saveSync(summary.id, project);
		expect(() => workspace.slice(summary.id, { plate: 2 })).toThrow(/nothing on plate 2/);
		expect(() => workspace.slice(summary.id, { plate: 3 })).toThrow(/no plate 3/);
		expect(() => workspace.send(summary.id, { plate: 1, printerId: null, queue: true })).toThrow(
			/not been sliced/
		);
		expect(() => workspace.preview(summary.id, 1)).toThrow(/not been sliced/);
	}, 60_000);

	it('sweeps plates of slicer projects that are gone', async () => {
		const { store, summary, workspace } = await setUp(['slicer-3mf', 'slicer-ui']);
		const dir = (workspace as unknown as { d: { dir: string } }).d.dir;
		fs.mkdirSync(`${dir}/${summary.id}`, { recursive: true });
		fs.mkdirSync(`${dir}/gone`, { recursive: true });
		workspace.sweep();
		expect(fs.existsSync(`${dir}/${summary.id}`)).toBe(true);
		expect(fs.existsSync(`${dir}/gone`)).toBe(false);
		store.remove(summary.id);
		workspace.sweep();
		expect(fs.existsSync(`${dir}/${summary.id}`)).toBe(false);
		await expect(workspace.info()).resolves.toMatchObject({ engine: null, capabilities: [] });
	}, 30_000);
});
