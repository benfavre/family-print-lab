import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from './db';
import { Lab } from './lab';
import { Backups } from './backup';

function workspace() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-restore-'));
	const db = openDatabase(path.join(root, 'lab.db'));
	const lab = new Lab(db);
	const models = path.join(root, 'models');
	fs.mkdirSync(path.join(models, 'm1'), { recursive: true });
	fs.writeFileSync(path.join(models, 'm1', 'v1.stl'), 'solid a');
	const mirror = path.join(root, 'mirror');
	fs.mkdirSync(mirror);
	const backups = new Backups(db, path.join(root, 'backups'), models, 14, mirror);
	const profileId = lab.createProfile({ name: 'Test maker', color: 'violet' });
	return { root, db, lab, models, mirror, backups, profileId };
}

describe('backups', () => {
	it('restores a snapshot: rows, model files, a safety copy first, and a change counter that moves forward', async () => {
		const { root, db, lab, models, mirror, backups, profileId } = workspace();
		try {
			lab.createProject({ title: 'Kept idea', profileId, category: 'Home' });
			const snap = await backups.create('manual');
			expect(snap).toMatchObject({ reason: 'manual', models: 1 });
			expect(fs.readdirSync(mirror)).toEqual([snap.file]);

			// Things go wrong after the snapshot: a project added, one model file lost.
			lab.createProject({ title: 'Later idea', profileId, category: 'Home' });
			fs.rmSync(path.join(models, 'm1', 'v1.stl'));
			const counter = lab.changeId();

			const result = await backups.restore(snap.file);
			expect(result.files).toBe(1);
			expect(fs.readFileSync(path.join(models, 'm1', 'v1.stl'), 'utf8')).toBe('solid a');
			expect(lab.snapshot().projects.map((p) => p.title)).toEqual(['Kept idea']);
			expect(lab.changeId()).toBeGreaterThan(counter);
			// The state just before the restore was kept, so the restore itself can be undone.
			const safety = backups.list().find((b) => b.reason === 'before-restore')!;
			const copy = openDatabase(path.join(backups.dir, safety.file, 'printlab.db'));
			expect(new Lab(copy).snapshot().projects).toHaveLength(2);
			copy.$client.close();
			// Foreign keys are back on afterwards.
			expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
		} finally {
			db.$client.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps this computer's cloud link through a restore (a backup may come from another computer)", async () => {
		const { root, db, backups } = workspace();
		try {
			const setLink = (value: string) =>
				db.$client
					.prepare(
						"INSERT INTO meta (key, value) VALUES ('cloud', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
					)
					.run(value);
			setLink('{"link":"the other computer"}');
			const snap = await backups.create('manual');
			setLink('{"link":"this computer"}');
			await backups.restore(snap.file);
			expect(db.$client.prepare("SELECT value FROM meta WHERE key = 'cloud'").get()).toEqual({
				value: '{"link":"this computer"}'
			});
		} finally {
			db.$client.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it('restores the oldest kept snapshot even when the safety copy pushes it past the limit', async () => {
		const { root, db, lab, backups, profileId } = workspace();
		try {
			lab.createProject({ title: 'Oldest state', profileId, category: 'Home' });
			const oldest = await backups.create('manual');
			for (let i = 0; i < 13; i++) await backups.create('manual');
			expect(backups.list().at(-1)?.file).toBe(oldest.file);
			lab.createProject({ title: 'Newer', profileId, category: 'Home' });
			await backups.restore(oldest.file);
			expect(lab.snapshot().projects.map((p) => p.title)).toEqual(['Oldest state']);
		} finally {
			db.$client.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it('refuses names that are not its own snapshots', async () => {
		const { root, db, backups } = workspace();
		try {
			await expect(backups.restore('../lab.db')).rejects.toThrow(/not there/);
		} finally {
			db.$client.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it('reports a mirror folder that is missing instead of failing the backup', async () => {
		const { root, db, mirror, backups } = workspace();
		try {
			fs.rmSync(mirror, { recursive: true });
			await backups.create('manual');
			expect(backups.mirrorStatus()).toMatchObject({ ok: false, problem: /mounted/ });
		} finally {
			db.$client.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
