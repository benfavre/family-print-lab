// The AMS module against simulated printers: RFID spools from the simulator, per-tray usage for a
// two-colour print, tray settings, RFID re-read, drying, and Spoolman against a fake server.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestLab, type TestLab } from '../../testing/harness';
import { fakeSliced } from '../../printer/sliced';
import { fakeSpoolman } from './fake-spoolman';
import { readAmsOptions } from './module';
import { allTrays, matchTray } from '$lib/shared/ams';
import type { ModelCode } from '$lib/shared/printers/models';

async function until<T>(check: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await check();
		if (v) return v as NonNullable<T>;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error('Timed out waiting for condition');
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function lab(fleet: ModelCode[]): Promise<TestLab> {
	const t = await startTestLab({ fleet, modules: ['ams'] });
	cleanups.push(() => t.stop());
	return t;
}
const ams = (t: TestLab) => t.rt.module('ams')!;
const trays = (t: TestLab, model: ModelCode) =>
	allTrays(t.rt.printers.get(t.printer(model).info.id)!.snapshot!);

describe('AMS sync with a simulated printer', () => {
	it('offers simulated RFID spools, charges a two-colour print to both and refunds on delete', async () => {
		const t = await lab(['C12']);
		const { info } = t.printer('C12');
		// The P1S's Bambu spools carry RFID tags in the simulator: suggested as new spools.
		const white = trays(t, 'C12').find((x) => x.global === 0)!;
		const black = trays(t, 'C12').find((x) => x.global === 3)!;
		expect(white.trayUuid).toMatch(/^[0-9A-F]{32}$/);
		expect(matchTray(white, t.rt.lab.snapshot().spools)).toEqual({ kind: 'new-rfid' });
		expect(matchTray(black, t.rt.lab.snapshot().spools)).toEqual({ kind: 'new-rfid' });

		const whiteId = ams(t).addFromTray(info.id, 0);
		const blackId = ams(t).addFromTray(info.id, 3);
		expect(
			ams(t)
				.state(info.id)
				.links.map((l) => [l.tray, l.spoolId])
		).toEqual([
			[0, whiteId],
			[3, blackId]
		]);
		const before = (id: string) => t.rt.lab.snapshot().spools.find((s) => s.id === id)!;
		const [w0, b0] = [before(whiteId).remainingGrams, before(blackId).remainingGrams];

		const { lab: l, printing } = t.rt;
		const profileId = l.createProfile({ name: 'Sam', color: 'green' });
		const projectId = l.createProject({ profileId, title: 'Chess set' });
		const jobId = l.createJob({ projectId });
		printing.attach(
			jobId,
			fakeSliced({
				minutes: 1,
				grams: 18,
				printerModelId: 'C12',
				filaments: [
					{ type: 'PLA', color: '#FFFFFF', grams: 12 },
					{ type: 'PLA', color: '#000000', grams: 6 }
				]
			}),
			'chess.gcode.3mf'
		);
		const charged = t.nextEvent('spool.charged', (e) => e.jobId === jobId, 15_000);
		printing.send(jobId, { printerId: info.id, useAms: true, amsMapping: [0, 3] });
		expect((await charged).charges).toEqual([
			{ spoolId: whiteId, tray: 0, grams: 12 },
			{ spoolId: blackId, tray: 3, grams: 6 }
		]);
		expect(before(whiteId).remainingGrams).toBe(w0 - 12);
		expect(before(blackId).remainingGrams).toBe(b0 - 6);
		l.deleteJob(jobId);
		expect(before(whiteId).remainingGrams).toBe(w0);
		expect(before(blackId).remainingGrams).toBe(b0);
	});

	it('links a known RFID spool by itself when it is loaded, and drops the link when it leaves', async () => {
		const t = await lab(['C12']);
		const { info, sim } = t.printer('C12');
		const id = ams(t).addFromTray(info.id, 1);
		// The spool is taken out (the link goes) and put back: the link comes back by RFID.
		const tray = sim.trays().find((x) => x.global === 1)!.tray;
		const saved = structuredClone(tray);
		for (const k of Object.keys(tray)) if (k !== 'id') delete tray[k];
		sim.report();
		await until(() => ams(t).spoolForTray(info.id, 1) === null);
		Object.assign(tray, saved);
		sim.report();
		await until(() => ams(t).spoolForTray(info.id, 1) === id);
		expect(ams(t).state(info.id).links).toMatchObject([{ tray: 1, spoolId: id }]);
		for (const k of Object.keys(tray)) if (k !== 'id') delete tray[k];
		sim.report();
		await until(() => ams(t).spoolForTray(info.id, 1) === null);
		expect(ams(t).state(info.id).links).toEqual([]);
	});

	it('sets a tray, re-reads a tag, sets the reading options and dries filament', async () => {
		const t = await lab(['N6']);
		const { info, sim } = t.printer('N6');
		const printer = t.rt.printers.require(info.id);
		// Tray 2 on the X2D holds a third-party PLA (no tag): it can be edited.
		const set = await printer.send('print.ams_filament_setting', {
			tray: 2,
			type: 'PETG',
			infoIdx: 'GFG99',
			color: 'FF0000FF',
			tempMin: 220,
			tempMax: 270
		});
		expect(set.outcome).toBe('confirmed');
		await until(() => trays(t, 'N6').find((x) => x.global === 2)?.type === 'PETG');
		expect(trays(t, 'N6').find((x) => x.global === 2)).toMatchObject({
			color: '#ff0000',
			infoIdx: 'GFG99',
			tempMin: 220
		});

		expect((await printer.send('print.ams_get_rfid', { tray: 0 })).outcome).toBe('confirmed');
		await printer.send('print.ams_user_setting', {
			startupRead: false,
			trayRead: true,
			remainCalibrate: true
		});
		await until(() => ams(t).state(info.id).options?.startupRead === false);
		expect(ams(t).state(info.id).options).toEqual({
			startupRead: false,
			trayRead: true,
			remainCalibrate: true
		});

		// The X2D's AMS 2 Pro dries: checking, then drying with the time counting down, then stop.
		await printer.send('print.ams_filament_drying', {
			amsId: 0,
			temp: 55,
			hours: 2,
			filament: 'PLA'
		});
		const unit = () => printer.snapshot!.ams.find((u) => u.id === 0)!;
		await until(() => unit().drying);
		expect(unit().drying).toMatchObject({ temp: 55, durationHours: 2, filament: 'PLA' });
		await until(() => unit().dryStatus === 2);
		await until(() => unit().drying!.remainingMinutes < 120);
		await printer.send('print.ams_filament_drying:stop', { amsId: 0 });
		await until(() => !unit().drying);
		expect(sim.state.ams.ams[0].dry_setting.dry_temperature).toBe(-1);
		// The P1S's AMS cannot dry.
		await expect(
			printer.send('print.ams_filament_drying', { amsId: 3, temp: 55, hours: 2, filament: 'PLA' })
		).rejects.toThrow(/not connected/);
	});

	it('imports from Spoolman and records each print there once turned on', async () => {
		const fake = await fakeSpoolman();
		cleanups.push(fake.close);
		const t = await lab(['C12']);
		const { info } = t.printer('C12');
		const spoolman = ams(t).spoolman;
		await expect(spoolman.import()).rejects.toThrow(/Turn on Spoolman/);
		expect(spoolman.save({ enabled: true, url: fake.url, token: 'tok' })).toMatchObject({
			enabled: true,
			hasToken: true,
			url: fake.url.replace(/\/$/, '')
		});
		expect(JSON.stringify(spoolman.view())).not.toContain('tok');
		expect(await spoolman.test()).toMatch(/0\.22\.1/);
		expect(await spoolman.import()).toEqual({ added: 2, skipped: 1 });
		expect(await spoolman.import()).toEqual({ added: 0, skipped: 3 });
		const galaxy = t.rt.lab.snapshot().spools.find((s) => s.colorName === 'Galaxy Black')!;
		expect(galaxy.remainingGrams).toBe(640);

		ams(t).link(info.id, 0, galaxy.id);
		const { lab: l, printing } = t.rt;
		const projectId = l.createProject({
			profileId: l.createProfile({ name: 'Kim', color: 'pink' }),
			title: 'Coaster'
		});
		const jobId = l.createJob({ projectId });
		printing.attach(
			jobId,
			fakeSliced({ minutes: 1, grams: 4, printerModelId: 'C12' }),
			'c.gcode.3mf'
		);
		printing.send(jobId, { printerId: info.id, useAms: true, amsMapping: [0] });
		await until(() => fake.used.length, 15_000);
		expect(fake.used).toEqual([{ id: 7, grams: 4, auth: 'Bearer tok' }]);

		// A print from a tray with no link: Lab charges the job's own spool, and Spoolman hears it.
		const second = l.createJob({ projectId, spoolId: galaxy.id });
		printing.attach(
			second,
			fakeSliced({ minutes: 1, grams: 3, printerModelId: 'C12' }),
			'd.gcode.3mf'
		);
		printing.send(second, { printerId: info.id, useAms: true, amsMapping: [1], force: true });
		await until(() => fake.used.length > 1, 15_000);
		expect(fake.used[1]).toEqual({ id: 7, grams: 3, auth: 'Bearer tok' });

		// Weights come back from Spoolman on demand.
		fake.spools[0].remaining_weight = 500;
		expect(await spoolman.pull()).toEqual({ updated: 1 });
		expect(t.rt.lab.snapshot().spools.find((s) => s.id === galaxy.id)!.remainingGrams).toBe(500);
		spoolman.save({ enabled: false, url: '' });
		expect(spoolman.view()).toMatchObject({ enabled: false, hasToken: true });
		// A new address never inherits the saved token: it has to be typed again.
		spoolman.save({ enabled: true, url: fake.url, token: 'tok' });
		expect(spoolman.save({ enabled: true, url: fake.url })).toMatchObject({ hasToken: true });
		expect(spoolman.save({ enabled: true, url: 'http://elsewhere.local:7912' })).toMatchObject({
			hasToken: false
		});
	});
});

describe('AMS reading options', () => {
	it('reads the flags the printer reports', () => {
		expect(readAmsOptions({ insert_flag: true, power_on_flag: false })).toEqual({
			startupRead: false,
			trayRead: true,
			remainCalibrate: null
		});
		expect(readAmsOptions({})).toBeNull();
		expect(readAmsOptions(undefined)).toBeNull();
	});
});
