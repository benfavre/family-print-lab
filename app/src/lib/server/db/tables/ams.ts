// AMS sync (ams package): which spool sits in which printer tray, and what each print took from each
// spool so deleting or cancelling the job gives it back exactly. Triggers in drizzle/0007_ams.sql do
// the refunds, so they happen however a job is deleted or re-opened.
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jobs, spools } from './core';
import { printers } from './printers';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** A spool loaded in a printer tray (tray = GlobalTray: 0–15, 24–27, 128–135, 254, 255). */
export const amsLinks = sqliteTable(
	'ams_links',
	{
		printerId: text('printer_id')
			.notNull()
			.references(() => printers.id, { onDelete: 'cascade' }),
		tray: integer('tray').notNull(),
		spoolId: text('spool_id')
			.notNull()
			.references(() => spools.id, { onDelete: 'cascade' }),
		linkedAt: text('linked_at').notNull().default(now),
		/** The tray's `remain` % when last seen, for the RFID reconcile hint. */
		lastRemain: integer('last_remain'),
		/** The tray's RFID uuid when last seen (a different one means the spool was swapped). */
		lastUuid: text('last_uuid')
	},
	(t) => [primaryKey({ columns: [t.printerId, t.tray] }), index('ams_links_spool').on(t.spoolId)]
);

/** Filament a print took from one spool, through one tray. */
export const spoolCharges = sqliteTable(
	'spool_charges',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id')
			.notNull()
			.references(() => jobs.id, { onDelete: 'cascade' }),
		spoolId: text('spool_id')
			.notNull()
			.references(() => spools.id, { onDelete: 'cascade' }),
		/** Refundable grams (0 once the spool was weighed by hand since). */
		grams: real('grams').notNull(),
		tray: integer('tray'),
		createdAt: text('created_at').notNull().default(now)
	},
	(t) => [index('spool_charges_job').on(t.jobId), index('spool_charges_spool').on(t.spoolId)]
);
