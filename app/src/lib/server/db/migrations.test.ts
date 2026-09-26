// Upgrading a database made before a migration: the tables as they were, rows in them, then every
// migration up to now. Catches migrations that only work on an empty database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '.';
import { Lab } from '../lab';
import { EventBus } from '../events';
import { PrinterManager } from '../printer/manager';

const MIGRATIONS = path.resolve('drizzle');
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A copy of the migrations folder that stops before migration `upTo` (its idx). */
function migrationsBefore(upTo: number) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-migrations-'));
	dirs.push(dir);
	const journal = JSON.parse(
		fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')
	);
	journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < upTo);
	fs.mkdirSync(path.join(dir, 'meta'));
	fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
	for (const e of journal.entries as { tag: string }[])
		fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
	return dir;
}

describe('the migration journal', () => {
	it('rises strictly in idx and in when, so no migration is ever skipped', () => {
		// Drizzle applies a migration only when its `when` is later than the newest one a database has
		// (drizzle-orm sqlite-core/dialect.js migrate). One merged with a lower `when` than a migration
		// already applied somewhere would be skipped there for good (docs/parity/PLAN.md 7.3).
		const { entries } = JSON.parse(
			fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')
		) as { entries: { idx: number; when: number; tag: string }[] };
		entries.forEach((e, i) => {
			expect(e.idx, e.tag).toBe(i);
			if (i) expect(e.when, e.tag).toBeGreaterThan(entries[i - 1].when);
			expect(fs.existsSync(path.join(MIGRATIONS, `${e.tag}.sql`)), e.tag).toBe(true);
		});
	});
});

describe('0005_printers on an existing database', () => {
	it('keeps every job, links nothing yet, and the env printer is imported on boot', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-upgrade-'));
		dirs.push(dir);
		const file = path.join(dir, 'lab.db');
		// The database as the app left it before printers had a table.
		const old = openDatabase(file, migrationsBefore(5));
		const run = (sql: string) => old.$client.prepare(sql).run();
		run("INSERT INTO profiles (id, name, color) VALUES ('pr', 'Alex', 'blue')");
		run("INSERT INTO projects (id, profile_id, title) VALUES ('pj', 'pr', 'Desk hook')");
		run(
			"INSERT INTO jobs (id, project_id, status, printer_task) VALUES ('j1', 'pj', 'Printing', ''), ('j2', 'pj', 'Succeeded', 'dock')"
		);
		expect(() => old.$client.prepare('SELECT printer_id FROM jobs').all()).toThrow(
			/no such column/
		);
		old.$client.close();

		const db = openDatabase(file);
		expect(
			db.$client.prepare('SELECT id, status, printer_id, dispatch FROM jobs ORDER BY id').all()
		).toEqual([
			{ id: 'j1', status: 'Printing', printer_id: null, dispatch: null },
			{ id: 'j2', status: 'Succeeded', printer_id: null, dispatch: null }
		]);
		expect(db.$client.pragma('foreign_key_check')).toEqual([]);
		expect(db.$client.pragma('integrity_check', { simple: true })).toBe('ok');

		const bus = new EventBus();
		const lab = new Lab(db, bus);
		const manager = new PrinterManager(db, lab, bus, {
			env: {
				BAMBU_HOST: '127.0.0.1',
				BAMBU_PORT: '1',
				BAMBU_SERIAL: '01p00a000000001',
				BAMBU_ACCESS_CODE: '12345678',
				BAMBU_MODEL: 'C12',
				BAMBU_TLS: 'off'
			},
			log: () => {}
		});
		manager.start();
		manager.stop();
		const [printer] = lab.printers();
		expect(printer).toMatchObject({ model: 'C12', serial: '01P00A000000001', hasAccessCode: true });
		// The job that was printing before the upgrade was for "any printer"; the task links it.
		expect(lab.linkStartedTask(printer.id, 'Desk_hook')).toBe('j1');
		expect(lab.getJob('j1')).toMatchObject({ printerId: printer.id, printerTask: 'Desk_hook' });
		// Removing the printer leaves the job's history in place.
		manager.remove(printer.id);
		expect(lab.getJob('j1')?.printerId).toBeNull();
		db.$client.close();
	});
});
