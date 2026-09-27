// The notification centre's rows: add (keeping the newest 500), list, unread count, mark read, clear.
import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../../db';
import { notifications } from '../../db/schema';
import type { NotificationItem, NotifyLevel } from '$lib/shared/notifications';

export const KEEP = 500;

export class NotificationStore {
	constructor(private db: DB) {}

	add(n: {
		event: string;
		level: NotifyLevel;
		title: string;
		body: string;
		printerId: string | null;
		jobId: string | null;
		link: string | null;
		at?: string;
	}): NotificationItem {
		const row = {
			id: crypto.randomUUID(),
			event: n.event,
			level: n.level,
			title: n.title,
			body: n.body,
			// A printer or job removed meanwhile: keep the message, drop the link to it.
			printerId: n.printerId && this.exists('printers', n.printerId) ? n.printerId : null,
			jobId: n.jobId && this.exists('jobs', n.jobId) ? n.jobId : null,
			link: n.link,
			createdAt: n.at ?? new Date().toISOString(),
			readAt: null
		};
		this.db.insert(notifications).values(row).run();
		this.prune();
		return row;
	}

	private exists(table: 'printers' | 'jobs', id: string) {
		return !!this.db.$client.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
	}

	/** Keeps the newest KEEP rows. */
	prune(keep = KEEP) {
		this.db.$client
			.prepare(
				`DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?)`
			)
			.run(keep);
	}

	/** Newest first; `before` (a createdAt) pages back. */
	list(o: { limit?: number; before?: string } = {}): NotificationItem[] {
		return this.db
			.select()
			.from(notifications)
			.where(o.before ? lt(notifications.createdAt, o.before) : undefined)
			.orderBy(desc(notifications.createdAt), desc(sql`rowid`))
			.limit(Math.min(Math.max(o.limit ?? 50, 1), 200))
			.all();
	}

	unread(): number {
		return (
			this.db.select({ n: count() }).from(notifications).where(isNull(notifications.readAt)).get()
				?.n ?? 0
		);
	}

	/** Marks some (or all) as read; returns how many changed. */
	markRead(ids: string[] | 'all'): number {
		const at = new Date().toISOString();
		return this.db
			.update(notifications)
			.set({ readAt: at })
			.where(
				ids === 'all'
					? isNull(notifications.readAt)
					: and(isNull(notifications.readAt), inArray(notifications.id, ids))
			)
			.run().changes;
	}

	clear(): number {
		return this.db.delete(notifications).run().changes;
	}

	remove(id: string): boolean {
		return this.db.delete(notifications).where(eq(notifications.id, id)).run().changes > 0;
	}
}
