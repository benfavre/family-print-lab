// Request shapes for the queue's API.
import { z } from 'zod';

const id = z.string().trim().min(1).max(64);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 21:30.');

export const queueAdd = z.strictObject({
	jobId: id,
	/** Null: any printer the file fits; left out: the job's own printer. */
	printerId: id.nullable().optional(),
	notBefore: z.iso.datetime({ offset: true }).nullable().optional(),
	requirePlateClear: z.boolean().optional()
});

export const queuePatch = z.strictObject({
	hold: z.boolean().optional(),
	printerId: id.nullable().optional(),
	notBefore: z.iso.datetime({ offset: true }).nullable().optional(),
	requirePlateClear: z.boolean().optional()
});

/** One column's new order; items from other columns move into it. */
export const queueReorder = z.strictObject({
	printerId: id.nullable(),
	ids: z.array(id).max(500)
});

export const queuePrinterPatch = z.strictObject({
	autoDispatch: z.boolean().optional(),
	paused: z.boolean().optional(),
	plateCleared: z.literal(true).optional(),
	/** Start the next job now, even with auto start off or in quiet hours. */
	startNext: z.literal(true).optional()
});

export const quietWindow = z
	.strictObject({ on: z.boolean(), start: hhmm, end: hhmm })
	.refine((w) => !w.on || w.start !== w.end, 'Quiet hours need different start and end times.');

export const queueSettings = z.strictObject({
	quietHours: z.array(quietWindow).length(7),
	requirePlateClear: z.boolean()
});
