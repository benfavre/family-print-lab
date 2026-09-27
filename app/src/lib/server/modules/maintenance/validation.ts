// Input schemas for the maintenance API.
import { z } from 'zod';
import { ACCESSORY_NOZZLE_TYPES, NOZZLE_DIAMETERS } from '$lib/shared/maintenance';

const hours = z.number().finite().positive().max(100_000).nullable();
const days = z.number().int().positive().max(3650).nullable();

/** A task of the user's own; with no interval it is a "when needed" task. */
export const taskInput = z.strictObject({
	label: z.string().trim().min(1, 'Required').max(120),
	intervalHours: hours.default(null),
	intervalDays: days.default(null),
	notes: z.string().trim().max(2000).default('')
});

export const taskPatch = z.strictObject({
	label: z.string().trim().min(1, 'Required').max(120).optional(),
	intervalHours: hours.optional(),
	intervalDays: days.optional(),
	notes: z.string().trim().max(2000).optional()
});

export const doneInput = z.strictObject({
	note: z.string().trim().max(500).default('')
});

export const baselineInput = z.strictObject({
	baselineHours: z.number().finite().min(0).max(100_000)
});

export const nozzleChangeInput = z.strictObject({
	diameter: z
		.number()
		.refine((d) => (NOZZLE_DIAMETERS as readonly number[]).includes(d), 'Not a Bambu nozzle size.'),
	type: z.enum(ACCESSORY_NOZZLE_TYPES).nullable().default(null),
	note: z.string().trim().max(500).default(''),
	/** Also tell the printer (system.set_accessories), on printers that take it. */
	send: z.boolean().default(false)
});
