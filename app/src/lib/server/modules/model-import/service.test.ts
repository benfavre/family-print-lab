import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { startTestLab, type TestLab } from '$lib/server/testing/harness';
import { projectSources, sketches } from '$lib/server/db/schema';
import { integrations } from '$lib/server/integrations';
import { kidAccess } from '$lib/server/kid/session';
import { ImportService } from './service';
import { fixture, scriptedFetch, tinyPng, TRIANGLE_STL, type Answer } from './testing';
import { toPng, isPng, pngSize, pictureDemuxer } from './pictures';
import { findFfmpeg } from '$lib/server/ffmpeg';
import { TaskCenter } from '$lib/server/tasks';
import type { TaskInfo } from '$lib/shared/tasks';
import type { Fetcher } from './fetch';
import type { RequestEvent } from '@sveltejs/kit';
import { GET as projectCredits } from '../../../../routes/api/projects/[id]/sources/+server';

let t: TestLab;
let profileId: string;
beforeAll(async () => {
	t = await startTestLab({ fleet: [], modules: ['model-import'] });
	profileId = t.rt.lab.createProfile({ name: 'Ana', color: 'pink' });
	(globalThis as Record<symbol, unknown>)[Symbol.for('family-print-lab.runtime')] = t.rt;
});
afterAll(() => {
	delete (globalThis as Record<symbol, unknown>)[Symbol.for('family-print-lab.runtime')];
	return t.stop();
});

function service(
	answers: Record<string, Answer>,
	o: { token?: string; ffmpeg?: string | null; tasks?: TaskCenter; fetch?: Fetcher } = {}
) {
	const site = scriptedFetch(answers);
	const imports = new ImportService({
		db: t.rt.db,
		lab: t.rt.lab,
		models: t.rt.models,
		fetch: o.fetch ?? site.fetch,
		tasks: o.tasks,
		thingiverseToken: () => o.token ?? '',
		ffmpeg: () => o.ffmpeg ?? null
	});
	return { imports, calls: site.calls };
}

const PRINTABLES_FILE = 'https://files.printables.com/media/prints/3161/stls/1_x/3dbenchy.stl';
const printablesAnswers = (): Record<string, Answer> => ({
	'graphql:PrintProfile': { type: 'application/json', body: fixture('printables-3161.json') },
	'graphql:GetDownloadLink': {
		type: 'application/json',
		body: JSON.stringify({
			data: { getDownloadLink: { ok: true, output: { link: PRINTABLES_FILE } } }
		})
	},
	[PRINTABLES_FILE]: { type: 'application/sla', body: TRIANGLE_STL },
	'https://media.printables.com/media/prints/3161/images/20206_70fde6a0-6da1-4522-ba46-25f1bece7199/thumbs/inside/1280x960/jpg/benchy.jpg':
		{ type: 'image/png', body: tinyPng() },
	'https://media.printables.com/media/prints/3161/images/20205_d6fc9f43-aa8d-466d-8f44-e0d20fe84f01/thumbs/inside/1280x960/jpg/benchy-02.jpg':
		{ type: 'image/jpeg', body: Buffer.from('ffd8ffe0', 'hex') }
});

describe('model import', () => {
	it('publishes import progress and links the finished task to its project without changing the result', async () => {
		const tasks = new TaskCenter();
		const seen: TaskInfo[] = [];
		tasks.events.on('task', (task: TaskInfo) => seen.push(task));
		const { imports } = service(printablesAnswers(), { tasks });
		const result = await imports.confirm({
			url: 'https://www.printables.com/model/3161',
			profileId,
			files: ['stl:49068']
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(result).toMatchObject({ created: true, pictures: 1, modelIds: [expect.any(String)] });
		expect(tasks.list()[0]).toMatchObject({
			kind: 'model-import',
			projectId: result.projectId,
			title: 'Import 3D BENCHY',
			status: 'done',
			stage: 'Imported with 1 skipped'
		});
		expect(seen.map((task) => task.stage)).toEqual(
			expect.arrayContaining([
				'Reading model details…',
				'Downloading file 1 of 1: 3dbenchy.stl',
				'Adding file 1 of 1: 3dbenchy.stl',
				'Saving picture 1 of 2…',
				'Saving credits…'
			])
		);
		const request = new Request(`http://localhost/api/projects/${result.projectId}/sources`);
		const response = await projectCredits({
			request,
			url: new URL(request.url),
			params: { id: result.projectId }
		} as unknown as RequestEvent);
		expect(response.status).toBe(200);
		expect((await response.json()).sources).toMatchObject([
			{ title: '3D BENCHY', author: 'Prusa Research', licence: 'Creative Commons — Public Domain' }
		]);
		const missing = await projectCredits({
			request,
			url: new URL(request.url),
			params: { id: 'missing' }
		} as unknown as RequestEvent);
		expect(missing.status).toBe(404);
	});

	it.each(['tray', 'request'])(
		'stopping an import from the %s aborts its download and never adds the returned model',
		async (from) => {
			const tasks = new TaskCenter();
			const site = scriptedFetch(printablesAnswers());
			let downloading!: () => void;
			const started = new Promise<void>((resolve) => {
				downloading = resolve;
			});
			const fetch: Fetcher = async (url, options) => {
				if (url === PRINTABLES_FILE) {
					downloading();
					await new Promise<void>((_, reject) =>
						options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
							once: true
						})
					);
				}
				return site.fetch(url, options);
			};
			const { imports } = service({}, { tasks, fetch });
			const before = t.rt.lab.snapshot().models.length;
			const controller = new AbortController();
			const importing = imports.confirm(
				{ url: 'https://www.printables.com/model/3161', profileId, files: ['stl:49068'] },
				controller.signal
			);
			const stopped = expect(importing).rejects.toThrow(/abort/i);
			await started;
			if (from === 'tray') tasks.cancel(tasks.list()[0].id);
			else controller.abort();
			await stopped;
			expect(tasks.list()[0].status).toBe('cancelled');
			expect(t.rt.lab.snapshot().models).toHaveLength(before);
		}
	);
	it('starts as a module with settings that never return the token, and an Integrations row', async () => {
		const m = t.rt.module('model-import')!;
		expect(m.settings()).toEqual({ hasThingiverseToken: false });
		expect(m.saveSettings({ thingiverseToken: 'abc123' })).toEqual({ hasThingiverseToken: true });
		expect(JSON.stringify(m.settings())).not.toContain('abc123');
		expect(() => m.saveSettings({ thingiverseToken: 'bad token!' })).toThrow(/token/);
		expect(m.saveSettings({})).toEqual({ hasThingiverseToken: true });
		expect(m.saveSettings({ thingiverseToken: '' })).toEqual({ hasThingiverseToken: false });
		const report = await integrations(t.rt, true);
		expect(report.items.find((i) => i.id === 'model-import')).toMatchObject({
			kind: 'module',
			available: true
		});
		// Kid mode cannot import or read through the image proxy.
		expect(kidAccess('POST', '/api/imports/url', null)).toBe('refuse');
		expect(kidAccess('GET', '/api/imports/image', null)).toBe('refuse');
	});

	it('Printables: a new project with credits, the chosen file as a model and a picture as a sketch', async () => {
		const { imports, calls } = service(printablesAnswers());
		const preview = await imports.preview({
			url: 'https://www.printables.com/model/3161-3d-benchy'
		});
		expect(preview.title).toBe('3D BENCHY');
		const result = await imports.confirm({
			url: 'https://www.printables.com/model/3161',
			profileId,
			files: ['stl:49068']
		});
		// The confirm reused the preview: one PrintProfile request in all.
		expect(calls.filter((c) => c.o.body?.includes('PrintProfile'))).toHaveLength(1);
		expect(result).toMatchObject({ created: true, pictures: 1 });
		expect(result.modelIds).toHaveLength(1);
		expect(result.skipped).toEqual([
			{ name: 'Picture 2', reason: 'Install ffmpeg to keep JPEG and WebP pictures.' }
		]);
		const ws = t.rt.lab.snapshot();
		const project = ws.projects.find((p) => p.id === result.projectId)!;
		expect(project.title).toBe('3D BENCHY');
		expect(project.url).toBe('https://www.printables.com/model/3161-3d-benchy');
		expect(project.description).toContain('Credits\n“3D BENCHY” by Prusa Research');
		expect(project.description).toContain('Licence: Creative Commons — Public Domain (CC0)');
		expect(ws.models.find((m) => m.id === result.modelIds[0])).toMatchObject({
			projectId: result.projectId,
			name: '3dbenchy',
			kind: 'mesh'
		});
		const source = t.rt.db
			.select()
			.from(projectSources)
			.where(eq(projectSources.projectId, result.projectId))
			.get()!;
		expect(source).toMatchObject({
			site: 'printables',
			url: 'https://www.printables.com/model/3161-3d-benchy',
			author: 'Prusa Research',
			authorUrl: 'https://www.printables.com/@Prusa3D',
			licence: 'Creative Commons — Public Domain',
			licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/'
		});
		expect(source.images).toHaveLength(2);
		expect(source.images[0].sketchId).toBeTruthy();
		expect(source.images[1].sketchId).toBeNull();
		const sketch = t.rt.db
			.select()
			.from(sketches)
			.where(eq(sketches.id, source.images[0].sketchId!))
			.get()!;
		expect(sketch).toMatchObject({
			projectId: result.projectId,
			title: 'Picture 1 from Printables'
		});
		expect(imports.sources(result.projectId)).toHaveLength(1);
	});

	it('adds to an existing project once, keeping its description and link', async () => {
		const projectId = t.rt.lab.createProject({
			profileId,
			title: 'Boats',
			description: 'Bath toys.',
			url: 'https://example.com/boats'
		});
		const { imports } = service(printablesAnswers());
		const input = {
			url: 'https://www.printables.com/model/3161',
			projectId,
			files: [],
			pictures: false
		};
		const first = await imports.confirm(input);
		expect(first).toMatchObject({ projectId, created: false, modelIds: [], pictures: 0 });
		await imports.confirm(input);
		const project = t.rt.lab.snapshot().projects.find((p) => p.id === projectId)!;
		expect(project.description.startsWith('Bath toys.\n\nCredits\n')).toBe(true);
		expect(project.description.match(/Credits/g)).toHaveLength(1);
		expect(project.url).toBe('https://example.com/boats');
		expect(imports.sources(projectId)).toHaveLength(1);
	});

	it('never shortens the family’s own text to fit the credit', async () => {
		const full = 'x'.repeat(3990);
		const input = (projectId: string) => ({
			url: 'https://www.printables.com/model/3161',
			projectId,
			files: [],
			pictures: false
		});
		const notesFree = t.rt.lab.createProject({ profileId, title: 'Full', description: full });
		const { imports } = service(printablesAnswers());
		expect((await imports.confirm(input(notesFree))).skipped).toEqual([]);
		let project = t.rt.lab.snapshot().projects.find((p) => p.id === notesFree)!;
		expect(project.description).toBe(full);
		expect(project.notes.startsWith('Credits\n“3D BENCHY” by Prusa Research')).toBe(true);

		const bothFull = t.rt.lab.createProject({
			profileId,
			title: 'Fuller',
			description: full,
			notes: full
		});
		const result = await imports.confirm(input(bothFull));
		expect(result.skipped).toEqual([{ name: 'Credits', reason: expect.stringMatching(/sources/) }]);
		project = t.rt.lab.snapshot().projects.find((p) => p.id === bothFull)!;
		expect([project.description, project.notes]).toEqual([full, full]);
		expect(imports.sources(bothFull)).toHaveLength(1);
	});

	it('Thingiverse: with a token, credits and the STL; the PDF cannot be chosen', async () => {
		const api = 'https://api.thingiverse.com/things/763622';
		const { imports } = service(
			{
				[api]: { type: 'application/json', body: fixture('thingiverse-763622-thing.json') },
				[`${api}/files`]: {
					type: 'application/json',
					body: fixture('thingiverse-763622-files.json')
				},
				[`${api}/images`]: {
					type: 'application/json',
					body: fixture('thingiverse-763622-images.json')
				},
				'https://cdn.thingiverse.com/assets/7d/fc/6e/33/fe/3DBenchy.stl': {
					type: 'application/octet-stream',
					body: TRIANGLE_STL
				}
			},
			{ token: 'tok' }
		);
		const url = 'https://www.thingiverse.com/thing:763622';
		await expect(imports.confirm({ url, profileId, files: ['1223855'] })).rejects.toThrow(
			/not an STL, 3MF or OBJ/
		);
		await expect(imports.confirm({ url, profileId, files: ['999'] })).rejects.toThrow(
			/not part of this model/
		);
		const result = await imports.confirm({ url, profileId, files: ['1223854'], pictures: false });
		expect(result.modelIds).toHaveLength(1);
		const project = t.rt.lab.snapshot().projects.find((p) => p.id === result.projectId)!;
		expect(project.description).toContain(
			'by CreativeTools (https://www.thingiverse.com/CreativeTools)'
		);
		expect(project.description).toContain('(CC BY-ND)');
		expect(project.description).toMatch(/do not share changed versions/);
	});

	it('MakerWorld: credits only; files are dropped in afterwards', async () => {
		const url = 'https://makerworld.com/en/models/1116432-cute-cat-planter';
		const { imports } = service({
			[url]: { type: 'text/html', body: fixture('makerworld-page.html') },
			'https://makerworld.bblmw.com/makerworld/model/US0000000000000/design/2025-01-10_cover.png': {
				type: 'image/png',
				body: tinyPng()
			},
			'https://makerworld.bblmw.com/makerworld/model/US0000000000000/design/2025-01-10_front.jpg': {
				type: 'image/png',
				body: tinyPng(8, 8)
			}
		});
		await expect(imports.confirm({ url, profileId, files: ['x'] })).rejects.toThrow(
			/not part of this model/
		);
		const result = await imports.confirm({ url, profileId, files: [] });
		expect(result).toMatchObject({ created: true, modelIds: [], pictures: 2, skipped: [] });
		const project = t.rt.lab.snapshot().projects.find((p) => p.id === result.projectId)!;
		expect(project.title).toBe('Cute Cat Planter');
		expect(project.description).toContain(
			'by Sample Maker (https://makerworld.com/@samplemaker), from MakerWorld'
		);
		expect(project.description).toMatch(/Personal use only/);
		// The drop zone then imports the downloaded file through ModelStore, like any upload.
		const id = t.rt.models.importFile(result.projectId, 'cat', Buffer.from(TRIANGLE_STL), 'stl');
		expect(t.rt.lab.snapshot().models.find((m) => m.id === id)?.projectId).toBe(result.projectId);
	});

	it('refuses other links, a missing owner and a missing project', async () => {
		const { imports } = service(printablesAnswers());
		await expect(imports.preview({ url: 'https://evil.com/model/1' })).rejects.toThrow(
			/Printables, Thingiverse or MakerWorld/
		);
		await expect(
			imports.confirm({ url: 'https://www.printables.com/model/3161', files: [] })
		).rejects.toThrow(/who the project is for/);
		await expect(
			imports.confirm({
				url: 'https://www.printables.com/model/3161',
				projectId: 'nope',
				files: []
			})
		).rejects.toThrow(/no longer exists/);
		await expect(imports.image('https://evil.com/a.png')).rejects.toThrow(/does not fetch/);
	});

	it('keeps a file that fails as skipped, with the reason', async () => {
		const answers = printablesAnswers();
		answers[PRINTABLES_FILE] = { type: 'application/sla', body: 'not a mesh' };
		const { imports } = service(answers);
		const result = await imports.confirm({
			url: 'https://www.printables.com/model/3161',
			profileId,
			files: ['stl:49068'],
			pictures: false
		});
		expect(result.modelIds).toEqual([]);
		expect(result.skipped).toEqual([
			{ name: '3dbenchy.stl', reason: 'That file is not a valid STL.' }
		]);
	});
});

describe('pictures', () => {
	it('names the demuxer from the first bytes, never from what the site says', () => {
		expect(pictureDemuxer(tinyPng())).toBe('png_pipe');
		expect(pictureDemuxer(Buffer.from('ffd8ffe000104a46', 'hex'))).toBe('jpeg_pipe');
		expect(pictureDemuxer(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('webp_pipe');
		expect(pictureDemuxer(Buffer.from('GIF89a\x01\x00'))).toBe('gif_pipe');
		expect(pictureDemuxer(Buffer.from('#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n'))).toBeNull();
		expect(pictureDemuxer(Buffer.from('ffconcat version 1.0\nfile /etc/passwd\n'))).toBeNull();
	});

	it('runs ffmpeg with a forced demuxer and pipes only, and not at all for other files', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-ffmpeg-'));
		const log = path.join(dir, 'args');
		const fake = path.join(dir, 'ffmpeg');
		fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\nexit 1\n`, { mode: 0o755 });
		try {
			expect(await toPng(Buffer.from('#EXTM3U\nhttp://192.168.1.1/\n'), fake)).toBeNull();
			expect(fs.existsSync(log)).toBe(false);
			expect(await toPng(Buffer.from('ffd8ffe0', 'hex'), fake)).toBeNull();
			const args = fs.readFileSync(log, 'utf8');
			expect(args).toContain('-protocol_whitelist pipe -f jpeg_pipe -i pipe:0');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

const ffmpeg = findFfmpeg();
describe.skipIf(!ffmpeg)('pictures with ffmpeg', () => {
	it('refuses a playlist behind a JPEG header', async () => {
		const trick = Buffer.concat([
			Buffer.from('ffd8ffe0', 'hex'),
			Buffer.from('\n#EXTM3U\n#EXTINF:1,\nfile:///etc/hostname\n')
		]);
		expect(await toPng(trick, ffmpeg)).toBeNull();
	});

	it('converts a JPEG to a PNG no wider than 1600 px', async () => {
		const jpeg = execFileSync(ffmpeg!, [
			'-hide_banner',
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'color=c=red:s=2000x100',
			'-frames:v',
			'1',
			'-f',
			'mjpeg',
			'pipe:1'
		]);
		const png = (await toPng(jpeg, ffmpeg))!;
		expect(isPng(png)).toBe(true);
		expect(pngSize(png)).toEqual({ width: 1600, height: 80 });
		expect(await toPng(Buffer.from('not an image'), ffmpeg)).toBeNull();
		expect(fs.existsSync(ffmpeg!)).toBe(true);
	});
});
