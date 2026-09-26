import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DB } from './db';
import { Lab } from './lab';
import { ModelStore } from './models';
import { CloudLink } from './cloud/link';
import { install, installed } from './shop';
import { packTemplates } from './kid/packs';
import { writeStl } from './cad/mesh';
import type { Runtime } from './runtime';
import { TEST_PACK } from './__fixtures__/pack';
import { startCloudSim, type CloudSim } from '../../../tools/cloud-sim';

let db: DB, lab: Lab, models: ModelStore, sim: CloudSim, link: CloudLink;
beforeEach(async () => {
	db = openDatabase(':memory:');
	lab = new Lab(db);
	models = new ModelStore(db, lab, fs.mkdtempSync(path.join(os.tmpdir(), 'shop-models-')));
	sim = await startCloudSim();
});
afterEach(async () => {
	link?.stop();
	await sim.close();
});

async function until(check: () => unknown) {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

describe('the shop in the app', () => {
	it('buys with credits and installs parts, models and kid packs', async () => {
		// A small tetrahedron, as a flat list of triangles (x, y, z × 3 each).
		const [a, b, c, d] = [
			[0, 0, 0],
			[20, 0, 0],
			[0, 20, 0],
			[0, 0, 5]
		];
		const triangle = writeStl(new Float32Array([a, c, b, a, b, d, a, d, c, b, c, d].flat()));
		sim.setShop({
			credits: 350,
			items: [
				{
					id: 'box',
					kind: 'part',
					title: 'Box',
					price: 150,
					content: { name: 'Box', source: 'size = 20; // [10:5:40]\ncube(size);' }
				},
				{
					id: 'stand',
					kind: 'model',
					title: 'Stand',
					price: 100,
					content: { file: '/device/library/stand/file', format: 'stl' }
				},
				{
					id: 'test-pack',
					kind: 'kid-pack',
					title: 'Test pack',
					price: 50,
					content: { pack: TEST_PACK }
				}
			],
			files: { stand: triangle }
		});
		sim.setPacks([]);
		link = new CloudLink(db, lab, models, sim.url, '2.1.5');
		const started = await link.link();
		sim.link(started.pairing!.userCode);
		await until(() => link.status().state === 'online');
		const rt = { db, lab, models, cloud: link } as unknown as Runtime;
		const profileId = lab.createProfile({ name: 'Sam', color: 'blue' });

		expect((await link.shopCatalogue()).balance).toBe(350);
		await expect(install(rt, 'box', profileId)).rejects.toThrow(/Buy it first/);
		expect((await link.buy('box')).balance).toBe(200);
		await expect(link.buy('box')).rejects.toThrow(/already have/);
		const part = await install(rt, 'box', profileId);
		const partModel = lab.snapshot().models.find((m) => m.projectId === part.projectId)!;
		expect(partModel).toMatchObject({ name: 'Box', kind: 'parametric' });
		expect(lab.snapshot().projects.find((p) => p.id === part.projectId)?.title).toBe('Box');

		await link.buy('stand');
		const model = await install(rt, 'stand', profileId);
		expect(lab.snapshot().models.find((m) => m.projectId === model.projectId)?.kind).toBe('mesh');
		await expect(link.buy('stand')).rejects.toThrow(/already have/);

		// A kid pack: the cloud now serves it, and installing it puts it in kid mode.
		await link.buy('test-pack');
		sim.setPacks([TEST_PACK]);
		const pack = await install(rt, 'test-pack', profileId);
		expect(pack).toEqual({ kind: 'kid-pack', projectId: null });
		expect(packTemplates().map((t) => t.id)).toEqual(['test-block']);
		expect(Object.keys(installed(db)).sort()).toEqual(['box', 'stand', 'test-pack']);
		expect((await link.shopCatalogue()).balance).toBe(50);
	});
});
