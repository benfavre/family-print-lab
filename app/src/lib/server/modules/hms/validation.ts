// Request schemas for the hms routes.
import { z } from 'zod';
import { MODEL_CODES } from '$lib/shared/printers/models';

const SEVERITIES = ['fatal', 'serious', 'common', 'info', 'unknown'] as const;

/** GET /api/printers/[id]/hms?severity=fatal,serious&limit=50&offset=0 */
export const historyQuery = z.object({
	severity: z
		.string()
		.max(60)
		.optional()
		.transform((s) => (s ? s.split(',').filter(Boolean) : []))
		.pipe(z.array(z.enum(SEVERITIES))),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).max(1_000_000).default(0)
});

/** GET /api/hms/lookup?code=0700_2000_0002_0001&printerId=… (or &model=C12) */
export const lookupQuery = z.object({
	code: z.string().min(1).max(40),
	printerId: z.string().max(64).optional(),
	model: z.enum(MODEL_CODES).optional()
});

/** POST /api/printers/[id]/hms/action */
export const actionBody = z.strictObject({
	code: z
		.string()
		.max(40)
		.regex(/^[0-9A-Fa-f_\s-]+$/, 'Not an error code.'),
	actionId: z.number().int().min(1).max(100_000)
});
