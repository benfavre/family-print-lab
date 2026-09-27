// Calibration runs (modules/slicer-calibration): each test sliced for a printer and filament, the job
// that prints it, and the value picked from the print, with where that value was saved.
import { sql } from 'drizzle-orm';
import { index, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
	CalibKind,
	CalibParams,
	CalibResult,
	CalibRunStatus,
	CalibStep
} from '../../../shared/slicer-calibration';
import type { PresetRef } from '../../../shared/slicer/project';
import { jobs, spools } from './core';
import { printers } from './printers';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const calibrationRuns = sqliteTable(
	'calibration_runs',
	{
		id: text('id').primaryKey(),
		kind: text('kind').$type<CalibKind>().notNull(),
		status: text('status').$type<CalibRunStatus>().notNull().default('slicing'),
		title: text('title').notNull().default(''),
		printerId: text('printer_id').references(() => printers.id, { onDelete: 'set null' }),
		spoolId: text('spool_id').references(() => spools.id, { onDelete: 'set null' }),
		filament: text('filament', { mode: 'json' }).$type<PresetRef>(),
		params: text('params', { mode: 'json' }).$type<CalibParams>().notNull(),
		steps: text('steps', { mode: 'json' })
			.$type<CalibStep[]>()
			.notNull()
			.default(sql`'[]'`),
		baseFlowRatio: real('base_flow_ratio'),
		jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
		taskId: text('task_id'),
		result: text('result', { mode: 'json' }).$type<CalibResult>(),
		error: text('error'),
		createdAt: text('created_at').notNull().default(now),
		updatedAt: text('updated_at').notNull().default(now)
	},
	(t) => [index('calibration_runs_created').on(t.createdAt)]
);
