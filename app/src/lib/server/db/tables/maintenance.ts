// The maintenance tracker (modules/maintenance): care tasks per printer with their intervals, the log of
// what was done, and a per-printer print-hours odometer baseline (hours printed before the app knew the
// printer, or outside it).
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { printers } from './printers';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const maintenanceTasks = sqliteTable(
	'maintenance_tasks',
	{
		id: text('id').primaryKey(),
		printerId: text('printer_id')
			.notNull()
			.references(() => printers.id, { onDelete: 'cascade' }),
		/** A default task's key ('z_lead_screws', 'carbon_filter'…) or 'custom'. */
		kind: text('kind').notNull(),
		label: text('label').notNull(),
		/** Due after this many print hours since last done; null = not by hours. */
		intervalHours: real('interval_hours'),
		/** Due after this many days since last done; null = not by days. */
		intervalDays: integer('interval_days'),
		/** When it was last done (or when the task was added, until it is done once). */
		lastDoneAt: text('last_done_at'),
		/** The odometer (print hours) when it was last done (or added). */
		lastDoneHours: real('last_done_hours'),
		notes: text('notes').notNull().default(''),
		/** The Bambu Lab wiki page a default task comes from; null for the user's own tasks. */
		source: text('source'),
		/** When the maintenance.due reminder went out; cleared when the task is done or changed. */
		notifiedAt: text('notified_at'),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: text('created_at').notNull().default(now),
		updatedAt: text('updated_at').notNull().default(now)
	},
	(t) => [index('maintenance_tasks_printer').on(t.printerId)]
);

export const maintenanceLog = sqliteTable(
	'maintenance_log',
	{
		id: text('id').primaryKey(),
		taskId: text('task_id').references(() => maintenanceTasks.id, { onDelete: 'set null' }),
		printerId: text('printer_id')
			.notNull()
			.references(() => printers.id, { onDelete: 'cascade' }),
		/** The task's kind, or 'nozzle' for a nozzle change. */
		kind: text('kind').notNull(),
		/** The task's label at the time, so the log still reads well after the task is removed. */
		label: text('label').notNull(),
		doneAt: text('done_at').notNull(),
		hoursAt: real('hours_at'),
		note: text('note').notNull().default('')
	},
	(t) => [index('maintenance_log_printer').on(t.printerId, t.doneAt)]
);

export const printersOdometer = sqliteTable('printers_odometer', {
	printerId: text('printer_id')
		.primaryKey()
		.references(() => printers.id, { onDelete: 'cascade' }),
	/** Print hours to add to the jobs the app recorded (the printer's life before the app). */
	baselineHours: real('baseline_hours').notNull().default(0),
	/** When the default tasks were added (once per printer, so removed ones stay removed). */
	seededAt: text('seeded_at'),
	/** When the AMS tasks were added (once, the first time the printer reports an AMS). */
	amsSeededAt: text('ams_seeded_at'),
	updatedAt: text('updated_at').notNull().default(now)
});
