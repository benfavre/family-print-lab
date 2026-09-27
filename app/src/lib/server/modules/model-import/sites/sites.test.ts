import { describe, expect, it } from 'vitest';
import { parseModelLink, type ModelLink } from '$lib/shared/model-import';
import { AppError } from '$lib/server/validation';
import { FetchStatusError } from '../fetch';
import { fixture, fixtureJson, scriptedFetch } from '../testing';
import { printables, printablesImage, printablesPreview, type PrintData } from './printables';
import { thingiverse, thingiversePreview, type ThingData, type ThingFile } from './thingiverse';
import { makerworld, makerworldPreview, titleFromLink } from './makerworld';

const link = (url: string) => parseModelLink(url) as ModelLink;
const print = (id: string) =>
	fixtureJson<{ data: { print: PrintData } }>(`printables-${id}.json`).data.print;

describe('Printables', () => {
	it('reads a saved CC0 answer: title, designer, licence, pictures, files', () => {
		const p = printablesPreview(link('https://www.printables.com/model/3161'), print('3161'));
		expect(p).toMatchObject({
			site: 'printables',
			id: '3161',
			url: 'https://www.printables.com/model/3161-3d-benchy',
			title: '3D BENCHY',
			author: 'Prusa Research',
			authorUrl: 'https://www.printables.com/@Prusa3D',
			licence: 'Creative Commons — Public Domain',
			terms: { code: 'CC0', caution: false },
			downloadable: true,
			note: null
		});
		expect(p.files).toEqual([
			{ id: 'stl:49068', name: '3dbenchy.stl', size: 11285384, format: 'stl' }
		]);
		expect(p.images[0]).toBe(
			'https://media.printables.com/media/prints/3161/images/20206_70fde6a0-6da1-4522-ba46-25f1bece7199/thumbs/inside/1280x960/jpg/benchy.jpg'
		);
		expect(p.description).toMatch(/^Update: The Iconic 3DBenchy/);
		expect(p.description).not.toMatch(/</);
	});

	it('flags a non-commercial licence and keeps files it cannot open, unselectable', () => {
		const p = printablesPreview(link('https://www.printables.com/model/500000'), print('500000'));
		expect(p.terms).toMatchObject({ code: 'CC BY-NC-SA', commercial: false, caution: true });
		expect(p.files[0]).toMatchObject({ name: 'PKK-004-6-002-01.STL', format: 'stl' });
		const withStep = printablesPreview(link('https://www.printables.com/model/1'), {
			...print('500000'),
			stls: [{ id: '9', name: 'Bear3_v6.f3d', fileSize: 10 }]
		});
		expect(withStep.files[0].format).toBeNull();
	});

	it('does not offer downloads for paid models', () => {
		const p = printablesPreview(link('https://www.printables.com/model/1'), {
			...print('3161'),
			premium: true
		});
		expect(p.downloadable).toBe(false);
		expect(p.note).toMatch(/paid model/);
	});

	it('builds gallery-size picture links', () => {
		expect(printablesImage('media/prints/1/images/2_x/a.b.png')).toBe(
			'https://media.printables.com/media/prints/1/images/2_x/thumbs/inside/1280x960/jpg/a.b.jpg'
		);
	});

	it('loads through the API and downloads a file through getDownloadLink', async () => {
		const file = 'https://files.printables.com/media/prints/3161/stls/1_x/3dbenchy.stl';
		const site = scriptedFetch({
			'graphql:PrintProfile': { type: 'application/json', body: fixture('printables-3161.json') },
			'graphql:GetDownloadLink': {
				type: 'application/json',
				body: JSON.stringify({ data: { getDownloadLink: { ok: true, output: { link: file } } } })
			},
			[file]: { type: 'application/sla', body: 'solid x' }
		});
		const loaded = await printables.load(link('https://www.printables.com/model/3161'), {
			fetch: site.fetch,
			thingiverseToken: ''
		});
		expect(loaded.preview.title).toBe('3D BENCHY');
		expect((await loaded.download('stl:49068', site.fetch)).toString()).toBe('solid x');
		const mutation = JSON.parse(site.calls[1].o.body!);
		expect(mutation.variables).toEqual({
			id: '49068',
			printId: '3161',
			fileType: 'stl',
			source: 'model_detail'
		});
		expect(site.calls.map((c) => new URL(c.url).hostname)).toEqual([
			'api.printables.com',
			'api.printables.com',
			'files.printables.com'
		]);
	});

	it('passes on why Printables will not give a file', async () => {
		const site = scriptedFetch({
			'graphql:PrintProfile': { type: 'application/json', body: fixture('printables-3161.json') },
			// The live API's answer for a file it will not hand out (2026-09-27).
			'graphql:GetDownloadLink': {
				type: 'application/json',
				body: '{"data":{"getDownloadLink":{"ok":false,"errors":[{"field":"non_field_error","messages":["files_cannot_be_downloaded"]}],"output":null}}}'
			}
		});
		const loaded = await printables.load(link('https://www.printables.com/model/3161'), {
			fetch: site.fetch,
			thingiverseToken: ''
		});
		await expect(loaded.download('stl:49068', site.fetch)).rejects.toThrow(
			'Printables did not give a download link for this file (files_cannot_be_downloaded).'
		);
	});

	it('says so when the model does not exist', async () => {
		const site = scriptedFetch({
			'graphql:PrintProfile': { type: 'application/json', body: '{"data":{"print":null}}' }
		});
		await expect(
			printables.load(link('https://www.printables.com/model/1'), {
				fetch: site.fetch,
				thingiverseToken: ''
			})
		).rejects.toThrow(/no model at that link/);
	});
});

describe('Thingiverse', () => {
	const l = link('https://www.thingiverse.com/thing:763622');
	const thing = fixtureJson<ThingData>('thingiverse-763622-thing.json');
	const files = fixtureJson<ThingFile[]>('thingiverse-763622-files.json');
	const images = fixtureJson<[]>('thingiverse-763622-images.json');

	it('reads saved answers: designer, no-derivatives licence, CDN pictures only', () => {
		const p = thingiversePreview(l, thing, files, images);
		expect(p).toMatchObject({
			title: '#3DBenchy - The jolly 3D printing torture-test by CreativeTools.se',
			author: 'CreativeTools',
			authorUrl: 'https://www.thingiverse.com/CreativeTools',
			licence: 'Creative Commons - Attribution - No Derivatives',
			terms: { code: 'CC BY-ND', remix: false, caution: true },
			downloadable: true
		});
		expect(p.images).toEqual([
			'https://cdn.thingiverse.com/renders/62/ab/d7/e3/ea/1_3D-printed_3DBenchy_by_Creative-Tools.com_display_large.JPG'
		]);
		expect(p.files.map((f) => [f.id, f.format])).toEqual([
			['1223854', 'stl'],
			['1223855', null]
		]);
	});

	it('without a token, explains how to continue and asks nothing', async () => {
		const site = scriptedFetch({});
		const loaded = await thingiverse.load(l, { fetch: site.fetch, thingiverseToken: '' });
		expect(loaded.preview).toMatchObject({ downloadable: false, files: [] });
		expect(loaded.preview.note).toMatch(/app token/);
		expect(site.calls).toHaveLength(0);
	});

	it('sends the token to the API only, and downloads from the CDN', async () => {
		const api = 'https://api.thingiverse.com/things/763622';
		const site = scriptedFetch({
			[api]: { type: 'application/json', body: JSON.stringify(thing) },
			[`${api}/files`]: { type: 'application/json', body: JSON.stringify(files) },
			[`${api}/images`]: { type: 'application/json', body: JSON.stringify(images) },
			'https://cdn.thingiverse.com/assets/7d/fc/6e/33/fe/3DBenchy.stl': {
				type: 'application/octet-stream',
				body: 'solid b'
			}
		});
		const loaded = await thingiverse.load(l, { fetch: site.fetch, thingiverseToken: 'tok' });
		expect((await loaded.download('1223854', site.fetch)).toString()).toBe('solid b');
		expect(site.calls.slice(0, 3).every((c) => c.o.headers?.authorization === 'Bearer tok')).toBe(
			true
		);
		expect(site.calls[3].o.headers?.authorization).toBeUndefined();
	});
});

describe('Thingiverse token', () => {
	it('says in plain words when the token is refused', async () => {
		const site = scriptedFetch({
			'https://api.thingiverse.com/things/763622': () => {
				throw new FetchStatusError(401, 'api.thingiverse.com');
			}
		});
		await expect(
			thingiverse.load(link('https://www.thingiverse.com/thing:763622'), {
				fetch: site.fetch,
				thingiverseToken: 'wrong'
			})
		).rejects.toThrow(/did not accept the app token/);
	});

	it('names files the API leaves unnamed', () => {
		const p = thingiversePreview(
			link('https://www.thingiverse.com/thing:1'),
			{ id: 1, name: null },
			[{ id: 7, name: null }],
			[]
		);
		expect(p.title).toBe('Thingiverse thing 1');
		expect(p.files).toEqual([{ id: '7', name: 'File 7', size: null, format: null }]);
	});
});

describe('MakerWorld', () => {
	const l = link('https://makerworld.com/en/models/1116432-cute-cat-planter');

	it('reads the page data: designer, licence, pictures on the MakerWorld CDN, no files', () => {
		const p = makerworldPreview(l, fixture('makerworld-page.html'));
		expect(p).toMatchObject({
			title: 'Cute Cat Planter',
			author: 'Sample Maker',
			authorUrl: 'https://makerworld.com/@samplemaker',
			licence: 'BY-NC-SA',
			terms: { code: 'CC BY-NC-SA', caution: true },
			description: 'A small planter shaped like a cat.\nPrints without supports.',
			files: [],
			downloadable: false
		});
		expect(p.images).toEqual([
			'https://makerworld.bblmw.com/makerworld/model/US0000000000000/design/2025-01-10_cover.png',
			'https://makerworld.bblmw.com/makerworld/model/US0000000000000/design/2025-01-10_front.jpg'
		]);
		expect(p.note).toMatch(/drop the file here/);
	});

	it('falls back to Open Graph tags, then to the link', () => {
		const og = makerworldPreview(l, fixture('makerworld-og.html'));
		expect(og).toMatchObject({
			title: 'Rocket Pencil Holder',
			description: 'Pencils & pens, ready for launch.',
			images: ['https://public-cdn.bblmw.com/rocket.jpg'],
			author: null,
			terms: { code: 'Unknown licence' }
		});
		const bare = makerworldPreview(l, null);
		expect(bare.title).toBe('Cute cat planter');
		expect(bare.note).toMatch(/did not let this app read the page/);
		expect(titleFromLink(link('https://makerworld.com/en/models/5'))).toBe('MakerWorld model 5');
		const quoted = makerworldPreview(
			l,
			`<meta content='Dan&#39;s "big" rocket | MakerWorld' property='og:title'><meta name="og:description" content="It's fun">`
		);
		expect(quoted).toMatchObject({ title: `Dan's "big" rocket`, description: "It's fun" });
	});

	it('keeps going when MakerWorld shows a bot check', async () => {
		const blocked = scriptedFetch({
			[l.url]: () => {
				throw new AppError(502, 'makerworld.com refused the request (403).');
			}
		});
		const loaded = await makerworld.load(l, { fetch: blocked.fetch, thingiverseToken: '' });
		expect(loaded.preview.title).toBe('Cute cat planter');
		await expect(loaded.download('x', blocked.fetch)).rejects.toThrow(/signed-in browsers/);
		const stopped = scriptedFetch({
			[l.url]: () => {
				throw new AppError(499, 'Stopped.');
			}
		});
		await expect(
			makerworld.load(l, { fetch: stopped.fetch, thingiverseToken: '' })
		).rejects.toThrow(/Stopped/);
	});
});
