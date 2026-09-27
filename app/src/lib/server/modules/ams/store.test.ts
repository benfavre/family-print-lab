// The AMS store over a real (in-memory) database: links, RFID spools, per-tray charges and the
// refund triggers in drizzle/0007_ams.sql.
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase, type DB } from '../../db';
import { jobs, printers } from '../../db/schema';
import { Lab } from '../../lab';
import { AmsStore } from './store';
import type { JobDispatch, SlicedInfo } from '$lib/shared/domain';
import type { PrinterTray } from '$lib/shared/printers/status';

const tray = (global: number, over: Partial<PrinterTray> = {}): PrinterTray =>
	({
		slot: String(global & 3),
		active: false,
		type: 'PLA',
		name: '',
		color: '#ffffff',
		remain: 80,
		global,
		colors: [],
		infoIdx: '',
		idName: '',
		tagUid: null,
		trayUuid: null,
		weight: null,
		isBambu: false,
		...over
	}) as PrinterTray;

let db: DB;
let lab: Lab;
let store: AmsStore;
let projectId: string;
beforeEach(() => {
	db = openDatabase(':memory:');
	lab = new Lab(db);
	store = new AmsStore(db, lab);
	db.insert(printers)
		.values({
			id: 'p1',
			name: 'X2D',
			model: 'N6',
			host: '127.0.0.1',
			serial: 'S1',
			accessCode: 'x'
		})
		.run();
	const profileId = lab.createProfile({ name: 'Alex', color: 'blue' });
	projectId = lab.createProject({ profileId, title: 'Two colours' });
});

const addSpool = (over: Record<string, unknown> = {}) =>
	lab.createSpool({
		material: 'PLA',
		colorHex: '#ffffff',
		totalGrams: 1000,
		remainingGrams: 1000,
		...over
	});
const spool = (id: string) => store.spool(id)!;

const sliced: SlicedInfo = {
	file: 'f.gcode.3mf',
	name: 'f',
	size: 1,
	plate: 1,
	printerModelId: 'N6',
	slicer: 'BambuStudio',
	source: 'upload',
	at: '',
	plates: [
		{
			index: 1,
			gcode: 'Metadata/plate_1.gcode',
			md5: '',
			minutes: 10,
			grams: 30,
			layers: 10,
			supports: false,
			filaments: [
				{ id: 1, type: 'PLA', color: '#ffffff', grams: 20, meters: 1 },
				{ id: 2, type: 'PLA', color: '#000000', grams: 10, meters: 1 }
			]
		}
	]
};
const dispatch: JobDispatch = {
	printerId: 'p1',
	plate: 1,
	useAms: true,
	amsMapping: [0, 3],
	remoteName: 'f.gcode.3mf',
	at: ''
};
/** A job sent from the app that the printer finished (Lab settled its single-spool charge). */
function finishedJob(o: { spoolId?: string; status?: 'Succeeded' | 'Failed' } = {}) {
	const id = lab.createJob({ projectId, spoolId: o.spoolId ?? null, grams: 30 });
	db.update(jobs).set({ sliced, dispatch }).where(eq(jobs.id, id)).run();
	lab.transitionJob(id, { to: 'Printing' });
	lab.transitionJob(id, { to: o.status ?? 'Succeeded' });
	return id;
}

describe('tray links', () => {
	it('links, moves a spool between trays and teaches it the RFID tag', () => {
		const a = addSpool();
		store.link('p1', tray(0), a);
		store.link('p1', tray(2), a);
		expect(store.links('p1').map((l) => [l.tray, l.spoolId])).toEqual([[2, a]]);
		store.link('p1', tray(1, { trayUuid: 'U1', tagUid: 'T1', infoIdx: 'GFA00' }), a);
		expect(spool(a)).toMatchObject({ rfidUuid: 'U1', rfidTag: 'T1', bambuInfoIdx: 'GFA00' });
		expect(() => store.link('p1', tray(3, { trayUuid: 'U2' }), a)).toThrow(/different Bambu/);
		expect(() => store.link('p1', tray(3, { type: '' }), a)).toThrow(/empty/);
	});

	it('refuses a spool when the tray’s tag belongs to another, and learns tag-only trays', () => {
		const known = addSpool();
		const other = addSpool();
		store.link('p1', tray(1, { trayUuid: 'U1', tagUid: 'T1' }), known);
		store.unlink('p1', undefined, 1);
		expect(() => store.link('p1', tray(1, { trayUuid: 'U1', tagUid: 'T1' }), other)).toThrow(
			/another spool from your shelf/
		);
		// A tray that only reports its tag_uid still teaches the spool.
		store.link('p1', tray(2, { tagUid: 'T2' }), other);
		expect(spool(other)).toMatchObject({ rfidUuid: null, rfidTag: 'T2' });
		// …and keeps the link (a spool without a tag would be dropped from a tagged tray).
		expect(store.sync('p1', [tray(2, { tagUid: 'T2' })])).toBe(false);
		expect(store.spoolForTray('p1', 2)).toBe(other);
	});

	it('forgets the tag when an RFID link is undone, so the sync does not link it back', () => {
		const a = addSpool();
		const t = tray(1, { trayUuid: 'U1', tagUid: 'T1' });
		store.link('p1', t, a);
		expect(store.unlink('p1', t, 1)).toBe(true);
		expect(spool(a)).toMatchObject({ rfidUuid: null, rfidTag: null });
		expect(store.sync('p1', [t])).toBe(false);
		expect(store.spoolForTray('p1', 1)).toBeNull();
		// A plain link just goes.
		store.link('p1', tray(0), a);
		expect(store.unlink('p1', tray(0), 0)).toBe(true);
		expect(store.unlink('p1', tray(0), 0)).toBe(false);
	});

	it('adds an RFID tray to the shelf once, linked', () => {
		const t = tray(5, {
			trayUuid: 'U5',
			tagUid: 'T5',
			weight: 1000,
			remain: 50,
			name: 'PLA Basic'
		});
		const id = store.addFromTray('p1', t);
		expect(spool(id)).toMatchObject({
			brand: 'Bambu Lab',
			remainingGrams: 500,
			rfidUuid: 'U5',
			notes: 'PLA Basic'
		});
		expect(store.spoolForTray('p1', 5)).toBe(id);
		expect(() => store.addFromTray('p1', t)).toThrow(/already on the shelf/);
	});

	it('follows the trays: drops stale links, links known RFID spools by itself', () => {
		const plain = addSpool({ colorHex: '#ff0000' });
		const rfid = addSpool();
		store.link('p1', tray(0, { color: '#ff0000' }), plain);
		store.link('p1', tray(1, { trayUuid: 'U', tagUid: 'T' }), rfid);
		// Nothing changed.
		expect(
			store.sync('p1', [tray(0, { color: '#ff0000' }), tray(1, { trayUuid: 'U', tagUid: 'T' })])
		).toBe(false);
		// The RFID spool moved to tray 3; tray 0 was emptied.
		expect(store.sync('p1', [tray(0, { type: '' }), tray(3, { trayUuid: 'U', tagUid: 'T' })])).toBe(
			true
		);
		expect(store.links('p1').map((l) => [l.tray, l.spoolId])).toEqual([[3, rfid]]);
		expect(store.linkFor('p1', 3)?.lastUuid).toBe('U');
	});
});

describe('charging prints per tray', () => {
	it('charges both linked spools by the sliced grams, and deleting the job refunds them', () => {
		const white = addSpool();
		const black = addSpool({ colorHex: '#000000' });
		store.link('p1', tray(0), white);
		store.link('p1', tray(3, { color: '#000000' }), black);
		const id = finishedJob();
		const result = store.chargeJob(id, 1);
		expect(result?.charges).toEqual([
			{ spoolId: white, tray: 0, grams: 20 },
			{ spoolId: black, tray: 3, grams: 10 }
		]);
		expect([spool(white).remainingGrams, spool(black).remainingGrams]).toEqual([980, 990]);
		// Once per job.
		expect(store.chargeJob(id, 1)).toBeNull();
		lab.deleteJob(id);
		expect([spool(white).remainingGrams, spool(black).remainingGrams]).toEqual([1000, 1000]);
		expect(store.charges(id)).toEqual([]);
	});

	it('gives back Lab’s single-spool charge so the print counts once, also after edits', () => {
		const white = addSpool();
		const chosen = addSpool({ colorHex: '#00ff00' });
		store.link('p1', tray(0), white);
		const id = finishedJob({ spoolId: chosen });
		expect(spool(chosen).remainingGrams).toBe(970);
		store.chargeJob(id, 1);
		expect(spool(chosen).remainingGrams).toBe(1000);
		expect(spool(white).remainingGrams).toBe(980);
		const job = lab.getJob(id)!;
		lab.updateJob(id, { version: job.version, notes: 'fine', grams: 40 });
		expect(spool(chosen).remainingGrams).toBe(1000);
	});

	it('charges a failed print by its progress; re-opening the job refunds it', () => {
		const white = addSpool();
		store.link('p1', tray(0), white);
		const id = finishedJob({ status: 'Failed' });
		store.chargeJob(id, 0.5);
		expect(spool(white).remainingGrams).toBe(990);
		lab.transitionJob(id, { to: 'Succeeded' });
		expect(spool(white).remainingGrams).toBe(990);
		const job = lab.getJob(id)!;
		lab.updateJob(id, { version: job.version, status: 'Cancelled' });
		expect(spool(white).remainingGrams).toBe(1000);
	});

	it('a print that failed before using anything still takes over from Lab’s charge', () => {
		const white = addSpool();
		const chosen = addSpool({ colorHex: '#00ff00' });
		store.link('p1', tray(0), white);
		const id = finishedJob({ spoolId: chosen, status: 'Failed' });
		expect(spool(chosen).remainingGrams).toBe(970);
		expect(store.chargeJob(id, 0)?.charges).toEqual([]);
		expect([spool(chosen).remainingGrams, spool(white).remainingGrams]).toEqual([1000, 1000]);
	});

	it('charges the spool that was in the tray when the print started', () => {
		const first = addSpool();
		const second = addSpool({ colorHex: '#fefefe' });
		const black = addSpool({ colorHex: '#000000' });
		store.link('p1', tray(0), first);
		const atStart = new Map(store.links('p1').map((l) => [l.tray, l.spoolId]));
		// The first spool ran out and was swapped mid-print; tray 3 was linked after the start.
		store.link('p1', tray(0), second);
		store.link('p1', tray(3, { color: '#000000' }), black);
		const id = finishedJob();
		expect(store.chargeJob(id, 1, atStart)?.charges).toEqual([
			{ spoolId: first, tray: 0, grams: 20 },
			{ spoolId: black, tray: 3, grams: 10 }
		]);
		expect(spool(second).remainingGrams).toBe(1000);
	});

	it('stops refunding once the spool was weighed by hand', () => {
		const white = addSpool();
		store.link('p1', tray(0), white);
		const id = finishedJob();
		store.chargeJob(id, 1);
		lab.updateSpool(white, { version: spool(white).version, remainingGrams: 900 });
		lab.deleteJob(id);
		expect(spool(white).remainingGrams).toBe(900);
	});

	it('leaves jobs that were not sent from the app to Lab', () => {
		const white = addSpool();
		store.link('p1', tray(0), white);
		const id = lab.createJob({ projectId, grams: 5, status: 'Succeeded' });
		expect(store.chargeJob(id, 1)).toBeNull();
	});
});
