import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../../db';
import { printers } from '../../db/schema';
import { Lab } from '../../lab';
import type { AnalyticsFilter } from '$lib/shared/analytics';
import { noteReason, rows, summary, weekOf, weeksBetween } from './queries';

// A small lab worked out by hand:
//   spools  s1 PLA 1000 g for 20 (0.02/g), s2 PETG 500 g for 15 (0.03/g), s3 TPU 1000 g, no price
//   printers Workshop (4 jobs) and Loft (none)
//   1 Alex · Dock   Succeeded s1 100 g, 120 min, Workshop   2026-09-07 10:00Z (a Monday)
//   2 Alex · Dock   Failed    s1  50 g,  30 min, Workshop   2026-09-08 10:00Z  note "Spaghetti"
//   3 Sam  · Stand  Succeeded s2 200 g, est. 300 min, none  2026-09-15 10:00Z
//   4 Sam  · Stand  Cancelled s2  80 g, ran 45 min, Workshop 2026-09-16 10:45Z  (uses no filament)
//   5 Alex · Tray   Succeeded no spool, PLA 40 g, 60 min, Workshop 2026-10-01 10:00Z
//   6 Alex · Tray   Succeeded s3 TPU 10 g, 10 min, none     2026-10-02 23:30Z  (10-03 at UTC+2)
//   plus a queued and a printing job, which never count.
let db: DB, lab: Lab;
const ids: Record<string, string> = {};
const all: AnalyticsFilter = { from: null, to: null, printerId: null, profileId: null, tz: 0 };

beforeEach(() => {
	db = openDatabase(':memory:');
	lab = new Lab(db);
	for (const [id, name, sortOrder] of [
		['p1', 'Workshop', 0],
		['p2', 'Loft', 1]
	] as const)
		db.insert(printers)
			.values({
				id,
				name,
				sortOrder,
				model: 'N6',
				host: '127.0.0.1',
				serial: `S-${id}`,
				accessCode: '12345678'
			})
			.run();
	ids.alex = lab.createProfile({ name: 'Alex', color: 'blue' });
	ids.sam = lab.createProfile({ name: 'Sam', color: 'green' });
	const spool = (material: string, totalGrams: number, cost: number | null) =>
		lab.createSpool({
			material,
			colorHex: '#123456',
			totalGrams,
			remainingGrams: totalGrams,
			cost
		});
	const s1 = spool('PLA', 1000, 20),
		s2 = spool('PETG', 500, 15),
		s3 = spool('TPU', 1000, null);
	const dock = lab.createProject({ profileId: ids.alex, title: 'Dock' });
	const stand = lab.createProject({ profileId: ids.sam, title: 'Stand' });
	const tray = lab.createProject({ profileId: ids.alex, title: 'Tray' });
	ids.dock = dock;
	const job = (o: Record<string, unknown>) => lab.createJob(o);
	ids.j1 = job({
		projectId: dock,
		status: 'Succeeded',
		spoolId: s1,
		grams: 100,
		actualMinutes: 120,
		printerId: 'p1',
		startedAt: '2026-09-07T08:00:00.000Z',
		finishedAt: '2026-09-07T10:00:00.000Z'
	});
	ids.j2 = job({
		projectId: dock,
		status: 'Failed',
		spoolId: s1,
		grams: 50,
		actualMinutes: 30,
		printerId: 'p1',
		notes: 'Spaghetti\nFirst layer lifted too.',
		finishedAt: '2026-09-08T10:00:00.000Z'
	});
	job({
		projectId: stand,
		status: 'Succeeded',
		spoolId: s2,
		grams: 200,
		minutes: 300,
		finishedAt: '2026-09-15T10:00:00.000Z'
	});
	job({
		projectId: stand,
		status: 'Cancelled',
		spoolId: s2,
		grams: 80,
		minutes: 200,
		printerId: 'p1',
		startedAt: '2026-09-16T10:00:00.000Z',
		finishedAt: '2026-09-16T10:45:00.000Z'
	});
	job({
		projectId: tray,
		status: 'Succeeded',
		material: 'PLA',
		grams: 40,
		actualMinutes: 60,
		printerId: 'p1',
		finishedAt: '2026-10-01T10:00:00.000Z'
	});
	job({
		projectId: tray,
		status: 'Succeeded',
		spoolId: s3,
		grams: 10,
		actualMinutes: 10,
		finishedAt: '2026-10-02T23:30:00.000Z'
	});
	job({ projectId: tray, grams: 500, spoolId: s1 });
	job({ projectId: dock, status: 'Printing', grams: 500, spoolId: s1, printerId: 'p1' });
});

describe('analytics summary', () => {
	it('adds up prints, success, filament, cost and printer time', () => {
		expect(summary(db, all).totals).toEqual({
			prints: 6,
			succeeded: 4,
			failed: 1,
			cancelled: 1,
			successRate: 0.8,
			grams: 400,
			cost: 9,
			uncostedGrams: 50,
			machineMinutes: 565,
			averageMinutes: 123
		});
	});

	it('leaves cancelled prints out of the success rate and filament', () => {
		const s = summary(db, { ...all, profileId: ids.sam });
		expect(s.totals).toMatchObject({ prints: 2, successRate: 1, grams: 200, cost: 6 });
		expect(s.byMaterial).toEqual([
			{ key: 'PETG', label: 'PETG', grams: 200, cost: 6, uncostedGrams: 0, prints: 1 }
		]);
	});

	it('prices filament from the spool (cost / total grams) and keeps jobs without a spool', () => {
		expect(summary(db, all).byMaterial).toEqual([
			{ key: 'PETG', label: 'PETG', grams: 200, cost: 6, uncostedGrams: 0, prints: 1 },
			{ key: 'PLA', label: 'PLA', grams: 190, cost: 3, uncostedGrams: 40, prints: 3 },
			{ key: 'TPU', label: 'TPU', grams: 10, cost: null, uncostedGrams: 10, prints: 1 }
		]);
		expect(summary(db, all).months).toEqual([
			{ month: '2026-09', material: 'PETG', grams: 200, cost: 6 },
			{ month: '2026-09', material: 'PLA', grams: 150, cost: 3 },
			{ month: '2026-10', material: 'PLA', grams: 40, cost: null },
			{ month: '2026-10', material: 'TPU', grams: 10, cost: null }
		]);
	});

	it('splits filament by person and printer', () => {
		const s = summary(db, all);
		expect(s.byPerson.map((p) => [p.label, p.grams, p.cost, p.prints])).toEqual([
			['Alex', 200, 3, 4],
			['Sam', 200, 6, 1]
		]);
		expect(s.byPrinter.map((p) => [p.key, p.label, p.grams, p.cost])).toEqual([
			['none', 'No printer set', 210, 6],
			['p1', 'Workshop', 190, 3]
		]);
	});

	it('gives machine hours per printer, saved printers without prints included', () => {
		expect(summary(db, all).hours).toEqual([
			{ key: 'none', label: 'No printer set', minutes: 310, prints: 2 },
			{ key: 'p1', label: 'Workshop', minutes: 255, prints: 4 },
			{ key: 'p2', label: 'Loft', minutes: 0, prints: 0 }
		]);
		expect(summary(db, { ...all, printerId: 'p1' }).hours).toEqual([
			{ key: 'p1', label: 'Workshop', minutes: 255, prints: 4 }
		]);
	});

	it('gives a weekly success rate with empty weeks filled in', () => {
		const weeks = summary(db, all).weeks;
		expect(weeks.map((w) => w.week)).toEqual([
			'2026-09-07',
			'2026-09-14',
			'2026-09-21',
			'2026-09-28'
		]);
		expect(weeks.map((w) => [w.succeeded, w.failed, w.cancelled, w.rate, w.grams])).toEqual([
			[1, 1, 0, 0.5, 150],
			[1, 0, 1, 1, 200],
			[0, 0, 0, null, 0],
			[2, 0, 0, 1, 50]
		]);
	});

	it('filters by date range, printer and person', () => {
		expect(summary(db, { ...all, from: '2026-09-14', to: '2026-09-30' }).totals.prints).toBe(2);
		expect(summary(db, { ...all, printerId: 'none' }).totals).toMatchObject({
			prints: 2,
			grams: 210
		});
		expect(summary(db, { ...all, printerId: 'p2' }).totals.prints).toBe(0);
		expect(summary(db, { ...all, profileId: ids.alex }).totals.prints).toBe(4);
	});

	it('reads dates in the viewer’s time zone', () => {
		const to = { ...all, from: '2026-10-01', to: '2026-10-02' };
		expect(summary(db, to).totals.prints).toBe(2);
		expect(summary(db, { ...to, tz: 120 }).totals.prints).toBe(1);
		expect(summary(db, { ...all, tz: 120 }).months.at(-1)).toEqual({
			month: '2026-10',
			material: 'TPU',
			grams: 10,
			cost: null
		});
	});

	it('ranks top projects by prints, then filament', () => {
		expect(
			summary(db, all).topProjects.map((p) => [p.title, p.owner, p.prints, p.succeeded, p.grams])
		).toEqual([
			['Stand', 'Sam', 2, 1, 200],
			['Dock', 'Alex', 2, 1, 150],
			['Tray', 'Alex', 2, 2, 50]
		]);
	});

	it('lists failure reasons from job notes when there is no printer error history', () => {
		const s = summary(db, all);
		expect(s.printerErrors).toBe(false);
		expect(s.failures).toEqual([{ reason: 'Spaghetti', count: 1, source: 'note' }]);
	});

	it('prefers the printer’s error text when the hms table exists', () => {
		// The hms package's table (PLAN 5.1); only the columns analytics reads matter here.
		db.$client.exec(`CREATE TABLE hms_events (
			id INTEGER PRIMARY KEY, printer_id TEXT, kind TEXT, code TEXT, severity TEXT, text TEXT,
			raised_at TEXT, cleared_at TEXT, job_id TEXT)`);
		db.$client
			.prepare(
				`INSERT INTO hms_events (printer_id, kind, code, text, raised_at, job_id) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				'p1',
				'print_error',
				'0300-4000',
				'The nozzle seems clogged.',
				'2026-09-08T09:59:00Z',
				ids.j2
			);
		const s = summary(db, all);
		expect(s.printerErrors).toBe(true);
		expect(s.failures).toEqual([
			{ reason: 'The nozzle seems clogged.', count: 1, source: 'printer' }
		]);
		expect(rows(db, all).find((r) => r.jobId === ids.j2)?.reason).toBe('The nozzle seems clogged.');
	});

	it('works on an empty lab', () => {
		const empty = openDatabase(':memory:');
		const s = summary(empty, all);
		expect(s.totals).toEqual({
			prints: 0,
			succeeded: 0,
			failed: 0,
			cancelled: 0,
			successRate: null,
			grams: 0,
			cost: null,
			uncostedGrams: 0,
			machineMinutes: 0,
			averageMinutes: null
		});
		expect(s.weeks).toEqual([]);
		expect(s.failures).toEqual([]);
	});

	it('offers the printers and people to filter by', () => {
		const s = summary(db, all);
		expect(s.options.printers).toEqual([
			{ id: 'p1', name: 'Workshop' },
			{ id: 'p2', name: 'Loft' }
		]);
		expect(s.options.people.map((p) => p.name)).toEqual(['Alex', 'Sam']);
	});
});

describe('analytics rows', () => {
	it('lists every finished print, newest first, with its cost and reason', () => {
		const list = rows(db, all);
		expect(list).toHaveLength(6);
		expect(list[0]).toMatchObject({
			date: '2026-10-02 23:30',
			project: 'Tray',
			material: 'TPU',
			cost: null
		});
		expect(list.find((r) => r.jobId === ids.j2)).toEqual({
			jobId: ids.j2,
			date: '2026-09-08 10:00',
			project: 'Dock',
			person: 'Alex',
			printer: 'Workshop',
			status: 'Failed',
			material: 'PLA',
			grams: 50,
			cost: 1,
			minutes: 30,
			reason: 'Spaghetti'
		});
	});
});

describe('helpers', () => {
	it('finds the Monday of a week', () => {
		expect(weekOf('2026-09-07')).toBe('2026-09-07');
		expect(weekOf('2026-09-13')).toBe('2026-09-07');
		expect(weekOf('2026-09-14')).toBe('2026-09-14');
		expect(weeksBetween('2026-12-30', '2027-01-06')).toEqual(['2026-12-28', '2027-01-04']);
		expect(weeksBetween('2020-01-01', '2026-01-01', 3)).toHaveLength(3);
	});

	it('shortens notes to their first line', () => {
		expect(noteReason('  Warped corner \nmore')).toBe('Warped corner');
		expect(noteReason('x'.repeat(200))).toHaveLength(120);
		expect(noteReason('')).toBe('');
	});
});
