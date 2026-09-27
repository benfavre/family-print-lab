// The AI check's history: rows in vision_checks and the pictures in <dataDir>/frames. Pictures older
// than 14 days are removed (the row stays, without its picture), and so are pictures without a row
// (a printer that was removed takes its rows with it).
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { jobs, visionChecks } from '$lib/server/db/schema';
import type { VisionCheck } from '$lib/shared/vision';

export const KEEP_FRAMES_MS = 14 * 86_400_000;

type Row = typeof visionChecks.$inferSelect;
export type NewCheck = Omit<Row, 'id' | 'frameFile'> & { frame: Buffer | null };

const view = (r: Row): VisionCheck => ({
	id: r.id,
	printerId: r.printerId,
	jobId: r.jobId,
	task: r.task,
	layer: r.layer,
	totalLayers: r.totalLayers,
	at: r.at,
	verdict: r.verdict,
	confidence: r.confidence,
	reason: r.reason,
	provider: r.provider,
	hasFrame: !!r.frameFile,
	alerted: r.alerted,
	paused: r.paused,
	error: r.error
});

export class VisionStore {
	readonly framesDir: string;

	constructor(
		private db: DB,
		dataDir: string
	) {
		this.framesDir = path.join(dataDir, 'frames');
	}

	add(c: NewCheck): VisionCheck {
		const id = crypto.randomUUID();
		const { frame, ...row } = c;
		let frameFile: string | null = null;
		if (frame) {
			fs.mkdirSync(this.framesDir, { recursive: true });
			frameFile = `${id}.jpg`;
			fs.writeFileSync(path.join(this.framesDir, frameFile), frame);
		}
		// A job removed while the check ran: keep the check, without the link.
		const jobId =
			row.jobId && this.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, row.jobId)).get()
				? row.jobId
				: null;
		const inserted = this.db
			.insert(visionChecks)
			.values({ ...row, jobId, id, frameFile })
			.returning()
			.get();
		return view(inserted);
	}

	/** Marks a check as having alerted and/or paused the print. */
	mark(id: string, patch: { alerted?: boolean; paused?: boolean; reason?: string }): VisionCheck {
		return view(
			this.db.update(visionChecks).set(patch).where(eq(visionChecks.id, id)).returning().get()
		);
	}

	/**
	 * Newest first; `before` is an `at` from the previous page. `problems`: only checks that alerted or
	 * saw something other than a normal print (not the ones that could not run).
	 */
	list(
		printerId: string,
		o: { before?: string; limit?: number; problems?: boolean } = {}
	): VisionCheck[] {
		return this.db
			.select()
			.from(visionChecks)
			.where(
				and(
					eq(visionChecks.printerId, printerId),
					o.before ? lt(visionChecks.at, o.before) : undefined,
					o.problems
						? or(
								eq(visionChecks.alerted, true),
								and(ne(visionChecks.verdict, 'ok'), isNull(visionChecks.error))
							)
						: undefined
				)
			)
			.orderBy(desc(visionChecks.at))
			.limit(o.limit ?? 50)
			.all()
			.map(view);
	}

	get(id: string): VisionCheck | null {
		const r = this.db.select().from(visionChecks).where(eq(visionChecks.id, id)).get();
		return r ? view(r) : null;
	}

	/** The check's picture, or null when there is none (any more). */
	frame(printerId: string, id: string): Buffer | null {
		const r = this.db
			.select({ frameFile: visionChecks.frameFile })
			.from(visionChecks)
			.where(and(eq(visionChecks.id, id), eq(visionChecks.printerId, printerId)))
			.get();
		if (!r?.frameFile) return null;
		try {
			return fs.readFileSync(path.join(this.framesDir, path.basename(r.frameFile)));
		} catch {
			return null;
		}
	}

	/** Removes pictures older than 14 days and pictures without a row; returns how many went. */
	prune(now = Date.now()): number {
		const cutoff = new Date(now - KEEP_FRAMES_MS).toISOString();
		const old = this.db
			.select({ id: visionChecks.id, frameFile: visionChecks.frameFile })
			.from(visionChecks)
			.where(and(isNotNull(visionChecks.frameFile), lt(visionChecks.at, cutoff)))
			.all();
		let removed = 0;
		for (const r of old) {
			fs.rmSync(path.join(this.framesDir, path.basename(r.frameFile!)), { force: true });
			this.db.update(visionChecks).set({ frameFile: null }).where(eq(visionChecks.id, r.id)).run();
			removed++;
		}
		let files: string[];
		try {
			files = fs.readdirSync(this.framesDir);
		} catch {
			return removed;
		}
		const known = new Set(
			this.db
				.select({ frameFile: visionChecks.frameFile })
				.from(visionChecks)
				.where(isNotNull(visionChecks.frameFile))
				.all()
				.map((r) => r.frameFile)
		);
		for (const f of files)
			if (!known.has(f)) {
				fs.rmSync(path.join(this.framesDir, f), { force: true });
				removed++;
			}
		return removed;
	}
}
