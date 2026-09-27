// Request shapes for the slicer workspace API (/api/slicer-ui).
import { z } from 'zod';

const id = z.string().max(80);
const plate = z.number().int().min(1).max(200);
const revision = z.number().int().min(0).optional();

export const presetRefBody = z.strictObject({
	kind: z.literal('printer'),
	name: z.string().max(200),
	source: z.enum(['system', 'user', 'project']),
	userPresetId: id.optional()
});

export const sliceBody = z.strictObject({
	plate,
	revision,
	/** The plate picture the printer shows: a PNG as base64 (the browser renders it). */
	thumbnail: z
		.string()
		.max(2_000_000, 'The plate picture is too large.')
		.regex(/^[A-Za-z0-9+/]+=*$/, 'The plate picture is not base64.')
		.nullable()
		.optional()
});

export const arrangeBody = z.strictObject({
	plate: z.union([plate, z.literal('all')]),
	revision,
	spacing: z.number().min(0).max(100).optional(),
	allowRotation: z.boolean().optional()
});

export const orientBody = z.strictObject({
	objectIds: z.array(id).min(1, 'Choose the objects to orient.').max(1000),
	revision
});

export const sendBody = z.strictObject({
	plate,
	printerId: id.nullable(),
	queue: z.boolean().default(false)
});

export const plateQuery = z.object({ plate: z.coerce.number().int().min(1).max(200) });
