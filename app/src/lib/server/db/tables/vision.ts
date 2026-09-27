// AI print checks (modules/ai-vision): every check of a printer's camera picture, what it saw, how sure
// it was, and whether it alerted or paused the print. The picture itself is a file beside the database
// (frame_file), removed after 14 days; the row stays as history.
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { VisionMethod, VisionVerdict } from '../../../shared/vision';
import { jobs } from './core';
import { printers } from './printers';

export const visionChecks = sqliteTable(
	'vision_checks',
	{
		id: text('id').primaryKey(),
		printerId: text('printer_id')
			.notNull()
			.references(() => printers.id, { onDelete: 'cascade' }),
		jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
		/** The print's name as the printer reported it. */
		task: text('task').notNull().default(''),
		layer: integer('layer'),
		totalLayers: integer('total_layers'),
		at: text('at').notNull(),
		verdict: text('verdict').$type<VisionVerdict>().notNull(),
		confidence: real('confidence').notNull().default(0),
		reason: text('reason').notNull().default(''),
		/** 'local' (the rough check) or the AI provider's id. */
		provider: text('provider').$type<VisionMethod>().notNull(),
		/** File name in the module's frames folder; null once pruned or when there was no picture. */
		frameFile: text('frame_file'),
		alerted: integer('alerted', { mode: 'boolean' }).notNull().default(false),
		paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
		/** Why the check could not run; the verdict is then 'unsure'. */
		error: text('error')
	},
	(t) => [index('vision_checks_printer').on(t.printerId, t.at)]
);
