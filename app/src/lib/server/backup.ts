import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db';
import { AppError } from './validation';

export interface BackupInfo {
	file: string;
	size: number;
	createdAt: string;
	/** Why it was taken: daily, manual, before-import, before-restore… */
	reason: string;
	/** Number of model files it holds. */
	models: number;
}

export interface RestoreResult {
	tables: number;
	rows: number;
	files: number;
}

/**
 * Backups: one folder per snapshot with a consistent online copy of the SQLite database and the model
 * files. Model version files never change after they are written, so they are hard-linked (no extra
 * space) when the file system allows it, and copied otherwise. Newest first; `keep` are retained.
 */
export class Backups {
	private timer?: NodeJS.Timeout;

	constructor(
		private db: DB,
		readonly dir: string,
		private modelsDir: string | null = null,
		private keep = 14,
		/** A folder on another disk that receives a full copy of each snapshot. */
		readonly mirror: string | null = null
	) {}

	list(): BackupInfo[] {
		if (!fs.existsSync(this.dir)) return [];
		return fs
			.readdirSync(this.dir)
			.filter((f) => /^printlab-/.test(f))
			.map((file) => {
				const full = path.join(this.dir, file);
				const stat = fs.statSync(full);
				const dbFile = stat.isDirectory() ? path.join(full, 'printlab.db') : full;
				const modelsDir = path.join(full, 'models');
				return {
					file,
					size: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0,
					createdAt: stat.mtime.toISOString(),
					reason: file.match(/Z-(.+)$/)?.[1] ?? file.split('-').pop() ?? '',
					models: stat.isDirectory() && fs.existsSync(modelsDir) ? countFiles(modelsDir) : 0
				};
			})
			// Newest first; the name's timestamp breaks ties between snapshots in the same millisecond.
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file));
	}

	/** `protect`: a snapshot that must survive pruning (the one about to be restored). */
	async create(reason = 'manual', protect?: string): Promise<BackupInfo> {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const name = `printlab-${stamp}-${reason}`;
		const target = path.join(this.dir, name);
		fs.mkdirSync(target, { recursive: true });
		await this.db.$client.backup(path.join(target, 'printlab.db'));
		if (this.modelsDir && fs.existsSync(this.modelsDir))
			linkTree(this.modelsDir, path.join(target, 'models'));
		for (const old of this.list().slice(this.keep))
			if (old.file !== protect)
				fs.rmSync(path.join(this.dir, old.file), { recursive: true, force: true });
		if (this.mirror) this.copyToMirror(target, name);
		return this.list().find((b) => b.file === name)!;
	}

	/** Where copies go on a second disk, if configured; its state for the UI. */
	mirrorStatus(): { dir: string | null; ok: boolean; problem: string } {
		if (!this.mirror) return { dir: null, ok: false, problem: '' };
		return { dir: this.mirror, ok: !this.mirrorProblem, problem: this.mirrorProblem };
	}
	private mirrorProblem = '';
	private copyToMirror(source: string, name: string) {
		try {
			if (!fs.existsSync(this.mirror!))
				throw new Error(`${this.mirror} is not there (is the disk mounted?)`);
			fs.cpSync(source, path.join(this.mirror!, name), { recursive: true });
			const kept = fs
				.readdirSync(this.mirror!)
				.filter((f) => /^printlab-/.test(f))
				.sort()
				.reverse();
			for (const old of kept.slice(this.keep))
				fs.rmSync(path.join(this.mirror!, old), { recursive: true, force: true });
			this.mirrorProblem = '';
		} catch (error) {
			this.mirrorProblem = (error as Error).message;
		}
	}

	/**
	 * Puts a snapshot back: a safety snapshot is taken first, then every table is replaced with the
	 * snapshot's rows in one transaction (columns added since are left at their defaults), and model
	 * files the snapshot knows about are put back. Returns what was restored.
	 */
	async restore(file: string): Promise<RestoreResult> {
		const found = this.list().find((b) => b.file === file);
		const dbFile = found && path.join(this.dir, file, 'printlab.db');
		if (!found || !dbFile || !fs.existsSync(dbFile))
			throw new AppError(404, 'That backup is not there.');
		await this.create('before-restore', file);

		const client = this.db.$client;
		const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
		const tablesOf = (schema: string) =>
			(
				client
					.prepare(
						`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`
					)
					.all() as { name: string }[]
			).map((r) => r.name);
		const columnsOf = (schema: string, table: string) =>
			(client.prepare(`PRAGMA ${schema}.table_info(${q(table)})`).all() as { name: string }[]).map(
				(c) => c.name
			);

		client.prepare('ATTACH DATABASE ? AS snap').run(dbFile);
		let rows = 0,
			tables = 0;
		try {
			const before = Number(
				(
					client.prepare(`SELECT value FROM meta WHERE key = 'change_id'`).get() as
						{ value: string } | undefined
				)?.value ?? 0
			);
			const inSnapshot = new Set(tablesOf('snap'));
			client.pragma('foreign_keys = OFF');
			client.transaction(() => {
				for (const table of tablesOf('main')) {
					client.prepare(`DELETE FROM main.${q(table)}`).run();
					if (!inSnapshot.has(table)) continue;
					const theirs = new Set(columnsOf('snap', table));
					const cols = columnsOf('main', table)
						.filter((c) => theirs.has(c))
						.map(q)
						.join(', ');
					rows += client
						.prepare(`INSERT INTO main.${q(table)} (${cols}) SELECT ${cols} FROM snap.${q(table)}`)
						.run().changes;
					tables++;
				}
				// Clients follow the change counter, so it must move forward, never back.
				client
					.prepare(
						`INSERT INTO meta (key, value) VALUES ('change_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
					)
					.run(String(before + 1));
				const broken = client.pragma('foreign_key_check') as unknown[];
				if (broken.length)
					throw new AppError(409, 'That backup does not fit together; nothing was changed.');
			})();
		} finally {
			client.pragma('foreign_keys = ON');
			client.prepare('DETACH DATABASE snap').run();
		}

		let files = 0;
		const snapModels = path.join(this.dir, file, 'models');
		if (this.modelsDir && fs.existsSync(snapModels))
			files = restoreTree(snapModels, this.modelsDir);
		return { tables, rows, files };
	}

	/** Takes a backup when the newest one is older than a day; checks every few hours. */
	schedule(log: (m: string) => void = () => {}) {
		const check = async () => {
			const newest = this.list()[0];
			if (!newest || Date.now() - Date.parse(newest.createdAt) > 24 * 3600_000) {
				try {
					const b = await this.create('daily');
					log(`Backup saved: ${b.file}`);
				} catch (error) {
					log(`Backup failed: ${(error as Error).message}`);
				}
			}
		};
		void check();
		this.timer = setInterval(check, 6 * 3600_000);
		this.timer.unref();
	}

	stop() {
		clearInterval(this.timer);
	}
}

function linkTree(from: string, to: string) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name),
			dst = path.join(to, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'blender') linkTree(src, dst); // Blender session files are scratch space
		} else if (/\.(stl|png)$/.test(entry.name)) {
			try {
				fs.linkSync(src, dst);
			} catch {
				fs.copyFileSync(src, dst);
			}
		}
	}
}

/** Copies back model files that are missing or differ; returns how many were written. */
function restoreTree(from: string, to: string): number {
	let n = 0;
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name),
			dst = path.join(to, entry.name);
		if (entry.isDirectory()) n += restoreTree(src, dst);
		else if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) {
			fs.rmSync(dst, { force: true });
			try {
				fs.linkSync(src, dst);
			} catch {
				fs.copyFileSync(src, dst);
			}
			n++;
		}
	}
	return n;
}

function countFiles(dir: string): number {
	let n = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
		n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
	return n;
}
