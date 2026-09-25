import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db';

export interface BackupInfo {
	file: string;
	size: number;
	createdAt: string;
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
		private keep = 14
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
				return {
					file,
					size: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0,
					createdAt: stat.mtime.toISOString()
				};
			})
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async create(reason = 'manual'): Promise<BackupInfo> {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const name = `printlab-${stamp}-${reason}`;
		const target = path.join(this.dir, name);
		fs.mkdirSync(target, { recursive: true });
		await this.db.$client.backup(path.join(target, 'printlab.db'));
		if (this.modelsDir && fs.existsSync(this.modelsDir))
			linkTree(this.modelsDir, path.join(target, 'models'));
		for (const old of this.list().slice(this.keep))
			fs.rmSync(path.join(this.dir, old.file), { recursive: true, force: true });
		return this.list().find((b) => b.file === name)!;
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
