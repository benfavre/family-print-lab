// The slicer project store and its routes against a test lab: create from model versions, import,
// save with revisions, download, meshes, sweeping, and (when an engine is installed) the engine's own
// reader opening what we write.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../testing/harness';
import { writeStl } from '../cad/mesh';
import { read3mf } from './read';
import { ProjectStore } from './store';
import { openSlicer } from '../slicer/engine';
import { kidAccess } from '../kid/session';
import { paintTriangle } from '$lib/shared/slicer/paint';
import type { Project } from '$lib/shared/slicer/project';
import * as list from '../../../routes/api/slicer-projects/+server';
import * as one from '../../../routes/api/slicer-projects/[id]/+server';
import * as download from '../../../routes/api/slicer-projects/[id]/file/+server';
import * as importRoute from '../../../routes/api/slicer-projects/import/+server';
import * as meshes from '../../../routes/api/slicer-projects/meshes/+server';
import * as meshFile from '../../../routes/api/slicer-projects/meshes/[meshId]/+server';

const fixtures = path.join(import.meta.dirname, '__fixtures__');
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');
let t: TestLab;
let store: ProjectStore;
let projectId: string;
let modelId: string;
let versionId: string;

// A 20 mm cube as a triangle soup.
function cube(size = 20) {
	const v = [
		[0, 0, 0],
		[1, 0, 0],
		[1, 1, 0],
		[0, 1, 0],
		[0, 0, 1],
		[1, 0, 1],
		[1, 1, 1],
		[0, 1, 1]
	].map((p) => p.map((c) => c * size - size / 2));
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
	return Float32Array.from(f.flatMap((tri) => tri.flatMap((i) => v[i])));
}

beforeAll(async () => {
	t = await startTestLab({ modules: ['slicer-3mf'], fleet: [] });
	holder[key] = t.rt;
	store = t.rt.module('slicer-3mf')!;
	const profileId = t.rt.lab.createProfile({ name: 'Alex', color: 'blue' });
	projectId = t.rt.lab.createProject({ profileId, title: 'Desk tidy' });
	modelId = t.rt.models.importFile(projectId, 'Cube', writeStl(cube()), 'stl');
	versionId = t.rt.models.detail(modelId).versions[0].id;
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

type Handler = (e: RequestEvent) => Promise<Response> | Response;
async function call(
	handler: Handler,
	o: {
		params?: Record<string, string>;
		url?: string;
		body?: unknown;
		raw?: Buffer;
		method?: string;
		headers?: Record<string, string>;
	} = {}
) {
	const url = new URL(o.url ?? 'http://localhost/api/slicer-projects');
	const request = new Request(url, {
		method: o.method ?? (o.body !== undefined || o.raw ? 'POST' : 'GET'),
		headers: {
			...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
			...o.headers
		},
		body: o.raw ? new Uint8Array(o.raw) : o.body !== undefined ? JSON.stringify(o.body) : undefined
	});
	const res = await handler({ params: o.params ?? {}, request, url } as unknown as RequestEvent);
	return res;
}
const jsonOf = async (res: Response) => ({ status: res.status, body: await res.json() });

describe('creating from model versions', () => {
	it('puts each model on plate 1, resting on the bed, and writes a Bambu project file', async () => {
		const { status, body } = await jsonOf(
			await call(list.POST, { body: { projectId, versions: [{ modelId, versionId }] } })
		);
		expect(status).toBe(200);
		const s = body.slicerProject;
		expect(s).toMatchObject({
			projectId,
			name: 'Cube',
			objects: 1,
			parts: 1,
			plates: 1,
			revision: 1
		});
		const project = await store.load(s.id);
		expect(project.objects[0].name).toBe('Cube');
		expect(project.objects[0].instances[0].transform.slice(9)).toEqual([128, 128, 10]);
		expect(project.plates[0].instances).toEqual([{ objectId: 'o1', instanceId: 'o1-i1' }]);
		const mesh = project.meshes[project.objects[0].parts[0].mesh];
		expect(mesh).toMatchObject({ triangles: 12, vertices: 8 });
		expect(mesh.storage).toEqual({ kind: 'file', path: store.meshPath(mesh.id) });

		const file = await call(download.GET, { params: { id: s.id } });
		expect(file.headers.get('content-type')).toBe('model/3mf');
		expect(file.headers.get('content-disposition')).toContain('Cube.3mf');
		const again = read3mf(Buffer.from(await file.arrayBuffer()));
		expect(again.project.objects).toHaveLength(1);
		expect(again.project.meta.title).toBe('Cube');
	});

	it('refuses models from another project and missing versions', async () => {
		const other = t.rt.lab.createProject({
			profileId: t.rt.lab.snapshot().profiles[0].id,
			title: 'Other'
		});
		expect(
			(await call(list.POST, { body: { projectId: other, versions: [{ modelId, versionId }] } }))
				.status
		).toBe(400);
		expect(
			(await call(list.POST, { body: { projectId, versions: [{ modelId, versionId: 'nope' }] } }))
				.status
		).toBe(404);
	});
});

describe('importing', () => {
	it('keeps an imported project byte for byte until the first save', async () => {
		const buf = fs.readFileSync(path.join(fixtures, 'synth-bambu-features.3mf'));
		const { status, body } = await jsonOf(
			await call(importRoute.POST, {
				url: `http://localhost/api/slicer-projects/import?projectId=${projectId}&name=Every%20feature.3mf`,
				raw: buf
			})
		);
		expect(status).toBe(200);
		expect(body.slicerProject).toMatchObject({ name: 'Every feature', objects: 2, plates: 2 });
		const file = await call(download.GET, { params: { id: body.slicerProject.id } });
		expect(Buffer.from(await file.arrayBuffer()).equals(buf)).toBe(true);
	});

	it('starts a project from an STL', async () => {
		const { body } = await jsonOf(
			await call(importRoute.POST, {
				url: `http://localhost/api/slicer-projects/import?projectId=${projectId}&name=Block.stl&format=stl`,
				raw: writeStl(cube(10))
			})
		);
		expect(body.slicerProject).toMatchObject({ name: 'Block', objects: 1 });
	});

	it('explains files that are not projects', async () => {
		const { status, body } = await jsonOf(
			await call(importRoute.POST, {
				url: `http://localhost/api/slicer-projects/import?projectId=${projectId}&name=x.3mf`,
				raw: Buffer.from('not a zip')
			})
		);
		expect(status).toBe(400);
		expect(body.error).toMatch(/not a valid 3MF/);
	});

	it('moves big passthrough files into the store instead of the JSON', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-store-'));
		const small = new ProjectStore(t.rt.db, t.rt.lab, t.rt.models, dir, 10_000);
		const { summary } = small.importFile(
			projectId,
			'Flow',
			fs.readFileSync(path.join(fixtures, 'bambu-flowrate-test-pass1.3mf'))
		);
		const project = await small.load(summary.id);
		expect(project.passthrough['Metadata/thumbnail.png']).toEqual({
			path: expect.stringMatching(new RegExp(`^${small.blobDir}/[0-9a-f]{64}\\.bin$`))
		});
		// Saved and read again, the blob is still used and the thumbnail unchanged.
		small.saveSync(summary.id, project);
		expect((await small.load(summary.id)).passthrough).toEqual(project.passthrough);
		small.remove(summary.id);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe('loading and saving', () => {
	let id: string;
	let loaded: { project: Project; revision: number };

	beforeAll(async () => {
		id = store.importFile(
			projectId,
			'Features',
			fs.readFileSync(path.join(fixtures, 'synth-bambu-features.3mf'))
		).summary.id;
		const { body } = await jsonOf(await call(one.GET, { params: { id } }));
		loaded = body;
	});

	it('answers the Project JSON with the summary', () => {
		expect(loaded.revision).toBe(1);
		expect(loaded.project.objects.map((o) => o.name)).toEqual(['Painted cube', 'Spinning tetra']);
		expect(loaded.project.objects[0].parts[0].paint?.color?.[3]).toBe('481');
	});

	it('saves edits, bumps the revision and refuses a stale save', async () => {
		const project = structuredClone(loaded.project);
		project.objects[1].name = 'Renamed';
		project.objects[1].parts[0].paint = { supports: { 0: paintTriangle(1) } };
		project.plates[1].bedType = 'Supertack Plate';
		const put = await jsonOf(
			await call(one.PUT, {
				params: { id },
				method: 'PUT',
				body: project,
				headers: { 'if-match': '1' }
			})
		);
		expect(put.status).toBe(200);
		expect(put.body.slicerProject.revision).toBe(2);
		expect(put.body.workspace).toBeUndefined();

		const stale = await call(one.PUT, {
			params: { id },
			method: 'PUT',
			body: project,
			headers: { 'if-match': '1' }
		});
		expect(stale.status).toBe(409);

		const back = await store.load(id);
		expect(back.objects[1].name).toBe('Renamed');
		expect(back.objects[1].parts[0].paint).toEqual({ supports: { 0: '4' } });
		expect(back.plates[1].bedType).toBe('Supertack Plate');
		// Everything else survived the browser round-trip.
		expect(back.objects[0]).toEqual(loaded.project.objects[0]);
		expect(back.passthrough).toEqual(loaded.project.passthrough);
	});

	it('refuses meshes that are not in the store and files outside it', async () => {
		const bad = structuredClone(loaded.project);
		bad.objects[0].parts[0].mesh = 'f'.repeat(64);
		const r1 = await jsonOf(await call(one.PUT, { params: { id }, method: 'PUT', body: bad }));
		expect(r1.status).toBe(400);
		expect(r1.body.error).toMatch(/not in the store/);

		const sneaky = structuredClone(loaded.project);
		sneaky.passthrough['Metadata/secret.txt'] = { path: '/etc/passwd' };
		const r2 = await jsonOf(await call(one.PUT, { params: { id }, method: 'PUT', body: sneaky }));
		expect(r2.status).toBe(400);
		expect(r2.body.error).toMatch(/outside the project store/);

		const typo = { ...structuredClone(loaded.project), extra: 1 };
		expect((await call(one.PUT, { params: { id }, method: 'PUT', body: typo })).status).toBe(400);
	});

	it('renames, lists and deletes', async () => {
		const renamed = await jsonOf(
			await call(one.PATCH, { params: { id }, method: 'PATCH', body: { name: 'Plates' } })
		);
		expect(renamed.body.slicerProject.name).toBe('Plates');
		const all = await jsonOf(
			await call(list.GET, { url: `http://localhost/api/slicer-projects?projectId=${projectId}` })
		);
		expect(all.body.slicerProjects.map((p: { id: string }) => p.id)).toContain(id);
		expect((await call(one.DELETE, { params: { id }, method: 'DELETE' })).status).toBe(200);
		expect((await call(one.GET, { params: { id } })).status).toBe(404);
	});
});

describe('meshes', () => {
	it('adds a model version or an upload and serves it back as STL', async () => {
		const fromModel = await jsonOf(
			await call(meshes.POST, {
				url: 'http://localhost/api/slicer-projects/meshes',
				body: { modelId, versionId }
			})
		);
		expect(fromModel.body.mesh).toMatchObject({ triangles: 12 });
		const upload = await jsonOf(
			await call(meshes.POST, {
				url: 'http://localhost/api/slicer-projects/meshes?format=stl',
				raw: writeStl(cube(5))
			})
		);
		expect(upload.body.mesh.id).toMatch(/^[0-9a-f]{64}$/);
		const stl = await call(meshFile.GET, { params: { meshId: upload.body.mesh.id } });
		expect(stl.headers.get('content-type')).toBe('model/stl');
		expect((await stl.arrayBuffer()).byteLength).toBe(84 + 12 * 50);
		expect((await call(meshFile.GET, { params: { meshId: '../../etc/passwd' } })).status).toBe(400);
	});
});

describe('sweeping', () => {
	it('removes files of deleted projects and old unused meshes, keeps the rest', () => {
		const other = t.rt.lab.createProject({
			profileId: t.rt.lab.snapshot().profiles[0].id,
			title: 'Doomed'
		});
		const doomedModel = t.rt.models.importFile(other, 'Big', writeStl(cube(33)), 'stl');
		const s = store.createFromModels(other, 'Doomed', [
			{ modelId: doomedModel, versionId: t.rt.models.detail(doomedModel).versions[0].id }
		]);
		const mesh = fs.readdirSync(store.meshDir).length;
		t.rt.lab.deleteProject(other); // the row goes with the project (ON DELETE CASCADE)
		const stray = store.putMesh(cube(44));
		store.sweep(Date.now() + 2 * 24 * 3600_000);
		expect(fs.existsSync(path.join(store.projectsDir, `${s.id}.3mf`))).toBe(false);
		expect(fs.existsSync(store.meshPath(stray.id))).toBe(false);
		expect(fs.readdirSync(store.meshDir).length).toBeLessThan(mesh + 1);
		// Projects still listed keep their meshes.
		for (const p of store.list()) expect(() => store.read(p.id)).not.toThrow();
	});
});

describe('kid mode', () => {
	it('keeps slicer projects to grown-ups', () => {
		expect(kidAccess('GET', '/api/slicer-projects', null)).toBe('refuse');
		expect(kidAccess('POST', '/api/slicer-projects/import', null)).toBe('refuse');
	});
});

// Upstream's own reader is the final judge of what we write. Runs only where Print Lab Slicer is
// installed (PRINTLAB_SLICER or a local build); skipped otherwise.
const engine = await openSlicer().catch(() => null);
describe.skipIf(!engine?.has('project.open'))('Print Lab Slicer reads what we write', () => {
	afterAll(() => engine?.close());
	it('opens every fixture after a round-trip with the same objects and plates', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-3mf-'));
		for (const f of fs.readdirSync(fixtures).filter((n) => n.endsWith('.3mf'))) {
			const id = store.importFile(projectId, f, fs.readFileSync(path.join(fixtures, f))).summary.id;
			const project = await store.load(id);
			await store.save(id, project);
			const target = path.join(dir, f);
			fs.copyFileSync(store.file(id).path, target);
			const opened = await engine!.call('project.open', { path: target });
			expect(opened.project.objects.map((o) => o.name)).toEqual(project.objects.map((o) => o.name));
			expect(opened.project.plates.length).toBe(project.plates.length);
		}
	});
});
