import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DB } from '../db';
import { Lab } from '../lab';
import { ModelStore } from '../models';
import { ParentPin } from '../kid/pin';
import type { KidProfile } from '../kid/session';
import { makeThing } from '../kid/things';
import type { Runtime } from '../runtime';
import { startCloudSim, type CloudSim } from '../../../../tools/cloud-sim';
import { EventEmitter } from 'node:events';
import type { PrinterStatus } from '$lib/shared/domain';
import { CloudLink, summarizePrinter } from './link';
import { open, unpack } from './vault';

let db: DB, lab: Lab, models: ModelStore, sim: CloudSim, links: CloudLink[];
beforeEach(async () => {
	db = openDatabase(':memory:');
	lab = new Lab(db);
	models = new ModelStore(db, lab, fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-models-')));
	new ParentPin(db).set({ pin: '2468' });
	sim = await startCloudSim();
	links = [];
});
afterEach(async () => {
	for (const l of links) l.stop();
	await sim.close();
});

/** A stand-in printer: set `status` and call `update()`. */
class FakePrinter extends EventEmitter {
	status: () => PrinterStatus = () => ({ configured: true, connected: true, state: null });
	update() {
		this.emit('update');
	}
}
let printer: FakePrinter;
const printing = (gcodeState: string, percent: number) => () =>
	({
		configured: true,
		connected: true,
		state: {
			gcodeState,
			percent,
			remainingMinutes: 12,
			layer: 40,
			totalLayers: 90,
			task: 'Name sign',
			nozzle: 220,
			bed: 60
		}
	}) as unknown as PrinterStatus;

const newLink = () => {
	printer = new FakePrinter();
	const l = new CloudLink(db, lab, models, sim.url, '2.0.0', undefined, printer);
	links.push(l);
	return l;
};

async function until(check: () => unknown, what: string) {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function linked() {
	const link = newLink();
	const started = await link.link();
	expect(started.state).toBe('pairing');
	expect(started.pairing?.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
	expect(sim.link(started.pairing!.userCode)).toBe(true);
	await until(() => link.status().state === 'online', 'online');
	return link;
}

async function kidRequest() {
	const id = lab.createProfile({ name: 'Léa', color: 'pink', kid: 'junior' });
	const kid = lab.snapshot().profiles.find((p) => p.id === id) as KidProfile;
	const spool = lab.createSpool({
		material: 'PLA',
		colorName: 'Sunset orange',
		colorHex: '#ff7a2f',
		totalGrams: 1000,
		remainingGrams: 900
	});
	const made = await makeThing({ db, lab, models } as unknown as Runtime, kid, 'stencil', {});
	models.saveThumbnail(made.modelId, made.versionId, Buffer.from('RIFFxxxxWEBPfake'), 'webp');
	const requestId = lab.requestPrint(kid.id, made.projectId, {
		spoolId: spool,
		message: 'Please! 🙏'
	});
	return { kid, made, requestId };
}

describe('Print Lab Cloud link', () => {
	it('links with a code, says hello, and reports only print requests', async () => {
		const link = await linked();
		expect(link.status()).toMatchObject({
			account: 'parent@example.com',
			plan: true,
			pairing: null
		});
		// Plan changes arrive while connected.
		sim.setPlan(false);
		await until(() => link.status().plan === false, 'the plan change');
		sim.setPlan(true);
		await until(() => link.status().plan === true, 'the plan back');
		expect(sim.state().hello).toEqual({ app: '2.0.0', protocol: 1 });
		const { requestId } = await kidRequest();
		await until(() => sim.state().requests.length === 1, 'the request');
		const [reported] = sim.state().requests;
		expect(reported).toMatchObject({
			id: requestId,
			version: 1,
			status: 'Waiting',
			kid: 'Léa',
			title: 'Drawing stencil',
			message: 'Please! 🙏',
			colour: { name: 'Sunset orange', hex: '#ff7a2f' },
			decidedAt: null
		});
		expect(reported.thumbnail).toMatch(/^data:image\/webp;base64,/);
		expect(Object.keys(reported).sort()).toEqual(
			[
				'colour',
				'createdAt',
				'decidedAt',
				'grams',
				'id',
				'kid',
				'message',
				'reply',
				'size',
				'status',
				'thumbnail',
				'title',
				'version'
			].sort()
		);

		link.setShareNames(false);
		await until(() => sim.state().requests[0]?.kid === 'Your child', 'names hidden');
	});

	it('applies an answer from the phone exactly like the Family page, once', async () => {
		await linked();
		const { requestId } = await kidRequest();
		await until(() => sim.state().requests.length === 1, 'the request');
		expect(await sim.decide(requestId, 'approve', 'Tonight!')).toEqual({ ok: true });
		const ws = lab.snapshot();
		expect(ws.printRequests[0]).toMatchObject({ status: 'Approved', reply: 'Tonight!' });
		expect(ws.jobs).toHaveLength(1);
		expect(ws.activity[0].message).toMatch(/\(from the phone, parent@example\.com\)$/);
		// The cloud's copy follows, and a stale second answer is refused.
		await until(() => sim.state().requests[0]?.status === 'Approved', 'the update');
		expect(await sim.decide(requestId, 'decline', '', 1)).toEqual({
			ok: false,
			error: 'This request was already answered.'
		});
		expect(await sim.decide('nope', 'approve')).toMatchObject({ ok: false });
	});

	it('reconnects after a restart, and forgets its token when unlinked from either side', async () => {
		const first = await linked();
		first.stop();
		const again = newLink();
		again.start();
		await until(() => again.status().state === 'online', 'reconnected');

		sim.unlink();
		await until(() => again.status().state === 'unlinked', 'unlinked by the cloud');
		expect(again.status().error).toMatch(/unlinked in Print Lab Cloud/);
		const stored = db.$client.prepare("select value from meta where key = 'cloud'").get() as {
			value: string;
		};
		expect(JSON.parse(stored.value).link).toBeNull();

		const third = await linked();
		expect(sim.state().devices).toHaveLength(1);
		await third.unlink();
		expect(third.status().state).toBe('unlinked');
		expect(sim.state().devices).toHaveLength(0);
	});

	it('cancels a pending link, and says when the cloud cannot be reached', async () => {
		const link = newLink();
		const started = await link.link();
		expect(started.state).toBe('pairing');
		link.cancelLink();
		expect(link.status()).toMatchObject({ state: 'unlinked', pairing: null });
		await expect(
			new CloudLink(db, lab, models, 'http://127.0.0.1:9', '2.0.0').link()
		).rejects.toThrow(/Cannot reach Print Lab Cloud/);
	});

	it('shares print progress only when switched on, with only what the phone shows', async () => {
		const link = await linked();
		printer.status = printing('RUNNING', 40);
		printer.update();
		await new Promise((r) => setTimeout(r, 100));
		// Off by default: only `null` on connecting, nothing about the printer.
		expect(sim.state().printer).toBeNull();
		expect(sim.state().printerMessages).toBe(1);

		link.setShareProgress(true);
		await until(() => sim.state().printer, 'printer');
		expect(sim.state().printer).toEqual({
			state: 'printing',
			title: 'Name sign',
			percent: 40,
			remainingMinutes: 12,
			layer: 40,
			totalLayers: 90
		});
		// Progress within 30 s waits; a new state goes at once.
		const before = sim.state().printerMessages;
		printer.status = printing('RUNNING', 41);
		printer.update();
		await new Promise((r) => setTimeout(r, 100));
		expect(sim.state().printerMessages).toBe(before);
		printer.status = printing('FINISH', 100);
		printer.update();
		await until(
			() => (sim.state().printer as { state?: string })?.state === 'finished',
			'finished'
		);
		expect(sim.state().printer).toMatchObject({ title: 'Name sign', percent: null });

		link.setShareProgress(false);
		await until(() => sim.state().printer === null, 'cleared');
		expect(link.status().shareProgress).toBe(false);
	});

	it('summarizes the printer without temperatures, trays or errors', () => {
		expect(summarizePrinter({ configured: false })).toBeNull();
		expect(summarizePrinter({ configured: true, connected: false })).toMatchObject({
			state: 'offline',
			title: ''
		});
		expect(Object.keys(summarizePrinter(printing('PREPARE', 0)())!)).toEqual([
			'state',
			'title',
			'percent',
			'remainingMinutes',
			'layer',
			'totalLayers'
		]);
	});

	it('backs up encrypted with a key only this computer has, and restores it', async () => {
		const link = await linked();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
		fs.writeFileSync(path.join(dir, 'printlab.db'), 'the whole workspace');
		await expect(link.uploadBackup(dir)).rejects.toThrow(/off/);

		const key = link.enableBackup();
		expect(link.enableBackup()).toBe(key); // the same key every time
		expect(link.status().backup).toMatchObject({ enabled: true, last: null });
		await link.uploadBackup(dir);
		expect(link.status().backup.last?.size).toBeGreaterThan(40);
		expect(sim.state().backups).toHaveLength(1);

		const [stored] = await link.listBackups();
		expect(stored).toMatchObject({ ours: true, device: 'Family Print Lab' });
		const sealed = await link.downloadBackup(stored.id);
		expect(sealed.includes(Buffer.from('the whole workspace'))).toBe(false);
		const to = fs.mkdtempSync(path.join(os.tmpdir(), 'restored-'));
		unpack(open(sealed, key), to);
		expect(fs.readFileSync(path.join(to, 'printlab.db'), 'utf8')).toBe('the whole workspace');

		// Without the plan the cloud refuses, and the app says why.
		sim.setPlan(false);
		await expect(link.uploadBackup(dir)).rejects.toThrow(/Family plan/);
		expect(link.status().backup.error).toMatch(/Family plan/);
		link.disableBackup();
		expect(link.backupEnabled()).toBe(false);
	});
});
