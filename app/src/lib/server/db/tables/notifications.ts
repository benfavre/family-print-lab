// The notification centre (the bell): what the lab told people, newest first, the last 500 kept.
import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { NotifyLevel } from '../../../shared/notifications';
import { jobs } from './core';
import { printers } from './printers';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const notifications = sqliteTable(
	'notifications',
	{
		id: text('id').primaryKey(),
		event: text('event').notNull(),
		level: text('level').$type<NotifyLevel>().notNull(),
		title: text('title').notNull(),
		body: text('body').notNull().default(''),
		printerId: text('printer_id').references(() => printers.id, { onDelete: 'set null' }),
		jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
		link: text('link'),
		createdAt: text('created_at').notNull().default(now),
		readAt: text('read_at')
	},
	(t) => [index('notifications_created').on(t.createdAt), index('notifications_read').on(t.readAt)]
);
