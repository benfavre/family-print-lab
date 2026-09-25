import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DB } from '../db';
import { Lab } from '../lab';
import { ModelStore } from '../models';
import { exportWorkspace, parseImport, replaceWorkspace } from '../portability';
import type { Runtime } from '../runtime';
import { ParentPin } from './pin';
import type { KidProfile } from './session';
import { makeThing } from './things';

let db: DB, lab: Lab, pin: ParentPin, rt: Runtime, clock: number;
beforeEach(() => {
	db = openDatabase(':memory:');
	lab = new Lab(db);
	clock = 1_000_000;
	pin = new ParentPin(db, () => clock);
	const models = new ModelStore(db, lab, fs.mkdtempSync(path.join(os.tmpdir(), 'kid-models-')));
	rt = { db, lab, models, pin } as unknown as Runtime;
});

const kidNamed = (name: string, kid: 'little' | 'junior' = 'junior') => {
	const id = lab.createProfile({ name, color: 'orange', age: 8, kid });
	return lab.snapshot().profiles.find((p) => p.id === id) as KidProfile;
};

describe('parent PIN', () => {
	it('is required before any profile can use kid mode', () => {
		expect(() => lab.createProfile({ name: 'Léa', color: 'pink', kid: 'little' })).toThrow(
			/parent PIN/
		);
		const id = lab.createProfile({ name: 'Léa', color: 'pink' });
		expect(() => lab.updateProfile(id, { kid: 'little', version: 1 })).toThrow(/parent PIN/);
		pin.set({ pin: '2468' });
		expect(lab.snapshot().parentPin).toBe(true);
		lab.updateProfile(id, { kid: 'little', version: 1 });
		expect(lab.snapshot().profiles[0].kid).toBe('little');
	});

	it('checks the PIN, needs the old one to change it, and slows down guessing', () => {
		expect(() => pin.set({ pin: '12' })).toThrow(/4 to 8 digits/);
		pin.set({ pin: '2468' });
		expect(pin.verify('2468')).toBe(true);
		expect(() => pin.set({ pin: '1357' })).toThrow(/not right/);
		expect(() => pin.set({ pin: '1357', current: '0000' })).toThrow(/not right/);
		pin.set({ pin: '1357', current: '2468' });
		expect(pin.verify('1357')).toBe(true);
		for (let i = 0; i < 4; i++) expect(() => pin.verify('0000')).toThrow(/not right/);
		expect(() => pin.verify('0000')).toThrow(/not right/); // fifth wrong guess locks it
		expect(() => pin.verify('1357')).toThrow(/Too many tries. Wait 30 seconds/);
		clock += 30_001;
		expect(() => pin.verify('0000')).toThrow(/not right/);
		expect(() => pin.verify('1357')).toThrow(/Wait 60 seconds/);
		clock += 60_001;
		expect(pin.verify('1357')).toBe(true);
		const stored = db.$client.prepare("select value from meta where key = 'parent_pin'").get() as {
			value: string;
		};
		expect(stored.value).not.toContain('1357');
	});
});

describe('things kids make and print requests', () => {
	beforeEach(() => pin.set({ pin: '2468' }));

	it('saves a thing as the child’s project with a parametric model of the safe parameters', async () => {
		const lea = kidNamed('Léa', 'little');
		const made = await makeThing(rt, lea, 'name-sign', { wanted_letter: 99, name: '' });
		const ws = lab.snapshot();
		const project = ws.projects.find((p) => p.id === made.projectId)!;
		expect(project).toMatchObject({
			profileId: lea.id,
			title: 'Name sign: Léa',
			category: 'Creative'
		});
		expect(project.checklist).toEqual([]);
		const detail = rt.models.detail(made.modelId);
		expect(detail.current?.params).toMatchObject({ name: 'Léa', wanted_letter: 26, min_width: 70 });
		expect(detail.current?.origin).toBe('kid:name-sign');
		await expect(makeThing(rt, lea, 'keychain', {})).rejects.toThrow(/older makers/);
	});

	it('goes from asking to an approved print job for the exact version and colour', async () => {
		const sam = kidNamed('Sam');
		const spool = lab.createSpool({
			material: 'PLA',
			colorName: 'Sunset orange',
			colorHex: '#ff7a2f',
			totalGrams: 1000,
			remainingGrams: 900
		});
		const made = await makeThing(rt, sam, 'stencil', { shape: 'star' });
		const id = lab.requestPrint(sam.id, made.projectId, { spoolId: spool, message: 'For school!' });
		expect(() => lab.requestPrint(sam.id, made.projectId, {})).toThrow(/already asked/);
		const other = kidNamed('Léa');
		expect(() => lab.requestPrint(other.id, made.projectId, {})).toThrow(/no longer exists/);

		const waiting = lab.snapshot().printRequests[0];
		expect(waiting).toMatchObject({ id, status: 'Waiting', modelVersionId: made.versionId });
		const jobId = lab.decideRequest(id, { decision: 'approve', reply: 'Tonight!', version: 1 });
		const ws = lab.snapshot();
		expect(ws.printRequests[0]).toMatchObject({ status: 'Approved', reply: 'Tonight!', jobId });
		expect(ws.jobs[0]).toMatchObject({
			id: jobId,
			status: 'Queued',
			spoolId: spool,
			material: 'PLA',
			modelVersionId: made.versionId,
			notes: 'Asked for by Sam: “For school!”'
		});
		expect(ws.projects.find((p) => p.id === made.projectId)?.status).toBe('Planned');
		expect(() => lab.decideRequest(id, { decision: 'decline', version: 2 })).toThrow(
			/already answered/
		);
		expect(ws.activity.map((a) => a.message)).toContain('Sam asked to print “Drawing stencil”');
	});

	it('can decline, and the child can ask again later', async () => {
		const sam = kidNamed('Sam');
		const made = await makeThing(rt, sam, 'treasure-dish', {});
		const first = lab.requestPrint(sam.id, made.projectId, {});
		lab.decideRequest(first, { decision: 'decline', reply: 'Let’s make it bigger', version: 1 });
		expect(lab.snapshot().jobs).toHaveLength(0);
		expect(lab.snapshot().printRequests[0]).toMatchObject({
			status: 'Declined',
			reply: 'Let’s make it bigger',
			jobId: null
		});
		lab.requestPrint(sam.id, made.projectId, {});
		expect(
			lab
				.snapshot()
				.printRequests.map((r) => r.status)
				.sort()
		).toEqual(['Declined', 'Waiting']);
	});

	it('keeps kid levels through export and import', () => {
		kidNamed('Sam');
		const other = new Lab(openDatabase(':memory:'));
		replaceWorkspace(
			other.db,
			other,
			parseImport(JSON.parse(JSON.stringify(exportWorkspace(lab))))
		);
		expect(other.snapshot().profiles[0].kid).toBe('junior');
	});
});
