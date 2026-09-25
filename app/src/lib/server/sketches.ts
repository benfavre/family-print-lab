// Hand-drawn sketches for project ideas. PNGs live in the database, so backups and restores include them.
import { eq, sql } from 'drizzle-orm';
import type { DB } from './db';
import { projects, sketches } from './db/schema';
import type { Lab } from './lab';
import { AppError } from './validation';

const PNG = '89504e470d0a1a0a';
const MAX = 4_000_000;

/** Reads width and height from a PNG header, and checks it is one. */
function pngSize(png: Buffer) {
	if (png.length < 24 || png.length > MAX || png.subarray(0, 8).toString('hex') !== PNG)
		throw new AppError(400, 'Sketches must be PNG images under 4 MB.');
	const width = png.readUInt32BE(16),
		height = png.readUInt32BE(20);
	if (!width || !height || width > 8000 || height > 8000)
		throw new AppError(400, 'That sketch is too large.');
	return { width, height };
}

export class SketchStore {
	constructor(
		private db: DB,
		private lab: Lab
	) {}

	png(id: string) {
		const row = this.db
			.select({ png: sketches.png })
			.from(sketches)
			.where(eq(sketches.id, id))
			.get();
		if (!row) throw new AppError(404, 'That sketch no longer exists.');
		return row.png;
	}

	create(projectId: string, png: Buffer, title = '') {
		const project = this.db
			.select({ id: projects.id, title: projects.title })
			.from(projects)
			.where(eq(projects.id, projectId))
			.get();
		if (!project) throw new AppError(404, 'That project no longer exists.');
		const { width, height } = pngSize(png);
		const id = crypto.randomUUID();
		this.db
			.insert(sketches)
			.values({ id, projectId, png, width, height, title: title.trim().slice(0, 80) })
			.run();
		this.lab.touch(
			'sketch',
			`Added a sketch${title.trim() ? ` “${title.trim().slice(0, 80)}”` : ''}`,
			projectId
		);
		return id;
	}

	update(id: string, png: Buffer) {
		const { width, height } = pngSize(png);
		const done = this.db
			.update(sketches)
			.set({
				png,
				width,
				height,
				updatedAt: new Date().toISOString(),
				version: sql`${sketches.version} + 1`
			})
			.where(eq(sketches.id, id))
			.run();
		if (!done.changes) throw new AppError(404, 'That sketch no longer exists.');
		this.lab.touch('sketch');
	}

	rename(id: string, title: string) {
		const done = this.db
			.update(sketches)
			.set({ title: title.trim().slice(0, 80) })
			.where(eq(sketches.id, id))
			.run();
		if (!done.changes) throw new AppError(404, 'That sketch no longer exists.');
		this.lab.touch('sketch');
	}

	remove(id: string) {
		const row = this.db
			.select({ projectId: sketches.projectId })
			.from(sketches)
			.where(eq(sketches.id, id))
			.get();
		if (!row) throw new AppError(404, 'That sketch no longer exists.');
		this.db.delete(sketches).where(eq(sketches.id, id)).run();
		this.lab.touch('sketch', 'Deleted a sketch', row.projectId);
	}
}
