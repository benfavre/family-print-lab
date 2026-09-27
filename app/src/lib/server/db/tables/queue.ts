// The print queue (modules/queue): jobs lined up for one printer or for any printer that fits, and
// each printer's queue switches (starts jobs by itself, paused, plate needs clearing).
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { QueueStatus } from '../../../shared/queue';
import { jobs } from './core';
import { printers } from './printers';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const queueItems = sqliteTable(
	'queue_items',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id')
			.notNull()
			.references(() => jobs.id, { onDelete: 'cascade' }),
		/** Null: any printer the file was sliced for. */
		printerId: text('printer_id').references(() => printers.id, { onDelete: 'set null' }),
		/** Order within its column (a printer, or "any printer"). */
		position: integer('position').notNull().default(0),
		/** ISO time before which it does not start. */
		notBefore: text('not_before'),
		requirePlateClear: integer('require_plate_clear', { mode: 'boolean' }).notNull().default(true),
		status: text('status').$type<QueueStatus>().notNull().default('waiting'),
		/** Why it is held or failed; null on a hold the person chose. */
		reason: text('reason'),
		createdAt: text('created_at').notNull().default(now),
		updatedAt: text('updated_at').notNull().default(now)
	},
	(t) => [
		uniqueIndex('queue_items_job').on(t.jobId),
		index('queue_items_printer').on(t.printerId, t.position),
		check(
			'queue_items_status',
			sql`${t.status} IN ('waiting', 'held', 'dispatching', 'sent', 'failed')`
		)
	]
);

export const queuePrinterState = sqliteTable('queue_printer_state', {
	printerId: text('printer_id')
		.primaryKey()
		.references(() => printers.id, { onDelete: 'cascade' }),
	autoDispatch: integer('auto_dispatch', { mode: 'boolean' }).notNull().default(true),
	/** Set when a print ends; the person confirms the plate is clear before the next one starts. */
	plateClearNeeded: integer('plate_clear_needed', { mode: 'boolean' }).notNull().default(false),
	paused: integer('paused', { mode: 'boolean' }).notNull().default(false)
});
