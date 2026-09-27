import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase, type DB } from '$lib/server/db';
import { jobs, printers } from '$lib/server/db/schema';
import { Lab } from '$lib/server/lab';
import { AppError } from '$lib/server/validation';
import { MaintenanceStore } from './store';

let db: DB, lab: Lab, store: MaintenanceStore, now: Date, projectId: string;
const day = 86_400_000;

beforeEach(() => {
	db = openDatabase(':memory:');
	lab = new Lab(db);
	now = new Date('2026-03-01T00:00:00.000Z');
	store = new MaintenanceStore(db, () => now);
	db.insert(printers)
		.values({
			id: 'p1',
			name: 'Workshop',
			model: 'C12',
			host: '127.0.0.1',
			serial: 'S1',
			accessCode: '12345678'
		})
		.run();
	const profileId = lab.createProfile({ name: 'Alex', color: 'blue' });
	projectId = lab.createProject({ profileId, title: 'Boat' });
});

/** A finished job on the printer that took `minutes`. */
function printed(minutes: number, printerId = 'p1') {
	const id = lab.createJob({ projectId });
	db.update(jobs)
		.set({ printerId, actualMinutes: minutes, status: 'Succeeded' })
		.where(eq(jobs.id, id))
		.run();
}

describe('the print-hours odometer', () => {
	it('adds up finished jobs on the printer and the baseline', () => {
		expect(store.odometer('p1')).toEqual({ jobHours: 0, baselineHours: 0, totalHours: 0 });
		printed(90);
		printed(30);
		expect(store.odometer('p1').jobHours).toBe(2);
		expect(store.setBaseline('p1', { baselineHours: 310.5 })).toEqual({
			jobHours: 2,
			baselineHours: 310.5,
			totalHours: 312.5
		});
		expect(() => store.setBaseline('p1', { baselineHours: -1 })).toThrow(AppError);
		expect(() => store.setBaseline('nope', { baselineHours: 1 })).toThrow(/not here/);
	});

	it('leaves out jobs on other printers and jobs without actual minutes', () => {
		db.insert(printers)
			.values({
				id: 'p2',
				name: 'Other',
				model: 'N1',
				host: '127.0.0.1',
				serial: 'S2',
				accessCode: '12345678'
			})
			.run();
		printed(600, 'p2');
		lab.createJob({ projectId });
		expect(store.odometer('p1').totalHours).toBe(0);
		expect(store.odometer('p2').totalHours).toBe(10);
	});
});

describe('maintenance tasks', () => {
	it('adds the model defaults once, so removed ones stay removed', () => {
		expect(store.seedDefaults('p1', 'C12')).toBeGreaterThan(3);
		const first = store.tasks('p1');
		expect(first.every((t) => t.source?.startsWith('https://wiki.bambulab.com/'))).toBe(true);
		expect(first.every((t) => t.due.state === 'ok' || t.due.state === 'manual')).toBe(true);
		store.deleteTask('p1', first[0].id);
		expect(store.seedDefaults('p1', 'C12')).toBe(0);
		expect(store.tasks('p1')).toHaveLength(first.length - 1);
	});

	it('adds the AMS tasks once, the first time an AMS is reported', () => {
		expect(store.seedAms('p1', [])).toBe(0);
		expect(store.amsSeeded('p1')).toBe(false);
		expect(store.seedAms('p1', [{ model: 'AMS' }])).toBe(2);
		expect(store.seedAms('p1', [{ model: 'AMS' }])).toBe(0);
		expect(store.amsSeeded('p1')).toBe(true);
	});

	it('becomes due by print hours and resets when marked done', () => {
		printed(60);
		const t = store.addTask('p1', { label: 'Oil the rods', intervalHours: 10 });
		expect(t.lastDoneHours).toBe(1); // counts from when it was added
		printed(9 * 60);
		expect(store.tasks('p1')[0].due).toMatchObject({ state: 'soon', hoursLeft: 1 });
		printed(60);
		expect(store.tasks('p1')[0].due.state).toBe('due');
		store.markDone('p1', t.id, { note: 'Used the white grease' });
		expect(store.tasks('p1')[0].due).toMatchObject({ state: 'ok', hoursLeft: 10 });
		expect(store.log('p1')).toMatchObject([
			{ taskId: t.id, label: 'Oil the rods', hoursAt: 11, note: 'Used the white grease' }
		]);
	});

	it('becomes due by days', () => {
		const t = store.addTask('p1', { label: 'Check belts', intervalDays: 30 });
		now = new Date(now.getTime() + 31 * day);
		expect(store.tasks('p1')[0].due).toMatchObject({ state: 'due', by: 'days' });
		store.markDone('p1', t.id);
		expect(store.tasks('p1')[0].due).toMatchObject({ state: 'ok', daysLeft: 30 });
	});

	it('edits and deletes only tasks of that printer', () => {
		const t = store.addTask('p1', { label: 'Custom' });
		expect(store.updateTask('p1', t.id, { label: 'Renamed', intervalDays: 7 })).toMatchObject({
			label: 'Renamed',
			intervalDays: 7
		});
		expect(() => store.updateTask('p2', t.id, { label: 'x' })).toThrow(/no longer exists/);
		expect(() => store.addTask('p1', { label: '' })).toThrow(AppError);
		expect(() => store.addTask('p1', { label: 'x', intervalHours: -2 })).toThrow(AppError);
		store.markDone('p1', t.id);
		store.deleteTask('p1', t.id);
		expect(store.tasks('p1')).toEqual([]);
		// The log keeps the entry, without the task.
		expect(store.log('p1')).toMatchObject([{ taskId: null, label: 'Renamed' }]);
	});

	it('logs nozzle changes', () => {
		printed(120);
		expect(store.logNozzleChange('p1', { diameter: 0.6, type: 'hardened_steel' })).toMatchObject({
			kind: 'nozzle',
			label: 'Nozzle changed to 0.6 mm hardened steel',
			hoursAt: 2
		});
		expect(() => store.logNozzleChange('p1', { diameter: 0.5 })).toThrow(/nozzle size/);
	});
});

describe('maintenance reminders', () => {
	it('announce each due task once until it is done', () => {
		const a = store.addTask('p1', { label: 'Grease', intervalHours: 1 });
		store.addTask('p1', { label: 'Never', intervalHours: 1000 });
		expect(store.collectDue()).toEqual([]);
		printed(90);
		const due = store.collectDue();
		expect(due).toMatchObject([{ task: { id: a.id }, printerName: 'Workshop', by: 'hours' }]);
		expect(store.collectDue()).toEqual([]);
		printed(90);
		expect(store.collectDue('p1')).toEqual([]);
		store.markDone('p1', a.id);
		expect(store.collectDue()).toEqual([]);
		printed(60);
		expect(store.collectDue()).toHaveLength(1);
	});

	it('can fire again after the interval changes', () => {
		const a = store.addTask('p1', { label: 'Grease', intervalDays: 10 });
		now = new Date(now.getTime() + 11 * day);
		expect(store.collectDue()).toHaveLength(1);
		store.updateTask('p1', a.id, { intervalDays: 30 });
		expect(store.collectDue()).toEqual([]);
		now = new Date(now.getTime() + 20 * day);
		expect(store.collectDue()).toHaveLength(1);
	});
});
