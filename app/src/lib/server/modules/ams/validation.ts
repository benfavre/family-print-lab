// Request bodies for the AMS routes and the Spoolman settings.
import { z } from 'zod';
import { DRYING_HOURS } from '$lib/shared/ams';
import { EXT_DEPUTY, EXT_MAIN } from '$lib/shared/printers/status';

export const trayNumber = z
	.number()
	.int()
	.refine(
		(t) =>
			(t >= 0 && t < 16) ||
			(t >= 24 && t <= 27) ||
			(t >= 128 && t <= 135) ||
			t === EXT_MAIN ||
			t === EXT_DEPUTY,
		'Not a filament tray.'
	);
const id = z.string().min(1).max(64);

export const linkInput = z.strictObject({ tray: trayNumber, spoolId: id });
export const trayInput = z.strictObject({ tray: trayNumber });
export const reconcileInput = z.strictObject({ tray: trayNumber });

export const traySettingsInput = z.strictObject({
	tray: trayNumber,
	/** Shelf material (MATERIALS) or a tray type. */
	material: z.string().min(1).max(40),
	colorHex: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a #rrggbb colour.'),
	tempMin: z.number().int().min(150).max(400),
	tempMax: z.number().int().min(150).max(400),
	/** Bambu filament id; the generic one for the material when left out. */
	infoIdx: z
		.string()
		.max(20)
		.regex(/^[\w-]*$/)
		.optional()
});

export const optionsInput = z.strictObject({
	startupRead: z.boolean(),
	trayRead: z.boolean(),
	remainCalibrate: z.boolean()
});

export const dryingInput = z.discriminatedUnion('action', [
	z.strictObject({
		action: z.literal('start'),
		amsId: z.number().int(),
		temp: z.number().int().min(45).max(85),
		hours: z.number().int().min(DRYING_HOURS.min).max(DRYING_HOURS.max),
		filament: z.string().max(20).default(''),
		rotateTray: z.boolean().default(false)
	}),
	z.strictObject({ action: z.literal('stop'), amsId: z.number().int() })
]);

/** Stored settings (meta settings:ams). The token never leaves the server. */
export const spoolmanSettings = z.object({
	enabled: z.boolean(),
	url: z.string().max(300),
	token: z.string().max(500),
	/** Record each print's usage in Spoolman. */
	pushUsage: z.boolean()
});
export type SpoolmanSettings = z.infer<typeof spoolmanSettings>;
export const SPOOLMAN_DEFAULTS: SpoolmanSettings = {
	enabled: false,
	url: '',
	token: '',
	pushUsage: true
};

/** PUT /api/spoolman: a token left out keeps the saved one; clearToken removes it. */
export const spoolmanInput = z.strictObject({
	enabled: z.boolean(),
	url: z.string().trim().max(300),
	token: z.string().trim().max(500).optional(),
	clearToken: z.boolean().optional(),
	pushUsage: z.boolean().default(true)
});
