// Printer error history (hms module): every HMS alert and print error a printer raised, when it
// cleared, and the job it happened during.
import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { HmsKind, HmsSeverity } from '../../../shared/hms';
import { jobs } from './core';
import { printers } from './printers';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const hmsEvents = sqliteTable(
	'hms_events',
	{
		id: text('id').primaryKey(),
		printerId: text('printer_id')
			.notNull()
			.references(() => printers.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<HmsKind>().notNull(),
		/** 16-hex (HMS) or 8-hex (print error) key, upper case. */
		code: text('code').notNull(),
		severity: text('severity').$type<HmsSeverity>().notNull(),
		/** The text at the time, so history reads the same after the database updates. */
		text: text('text').notNull(),
		raisedAt: text('raised_at').notNull().default(now),
		clearedAt: text('cleared_at'),
		jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' })
	},
	(t) => [
		index('hms_events_printer').on(t.printerId, t.raisedAt),
		index('hms_events_job').on(t.jobId)
	]
);
