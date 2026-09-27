// Request schemas for the calibration API.
import { z } from 'zod';
import { CALIB_KINDS } from '$lib/shared/slicer-calibration';
import { presetRef } from '../slicer-profiles/validation';

const finite = z.number().finite();

export const calibParams = z.strictObject({
	start: finite.optional(),
	end: finite.optional(),
	step: finite.optional(),
	pass: z.union([z.literal(1), z.literal(2)]).optional(),
	linear: z.boolean().optional(),
	printNumbers: z.boolean().optional()
});

export const calibRunInput = z.strictObject({
	kind: z.enum(CALIB_KINDS),
	printerId: z.string().min(1, 'Pick a printer.').max(80),
	spoolId: z.string().max(80).nullable().default(null),
	/** The filament preset to test; default: the spool's, else the printer's default for its material. */
	filament: presetRef.nullable().default(null),
	params: calibParams.default({}),
	/** Whose Calibration project the print goes into (default: the first grown-up). */
	profileId: z.string().max(80).nullable().default(null)
});

export const calibResultInput = z.strictObject({
	value: finite,
	label: z.string().trim().max(80).default(''),
	/** Save it into a user filament preset (and the spool, when the run has one). */
	save: z.boolean().default(true)
});

export const calibEnqueueInput = z.strictObject({
	printerId: z.string().max(80).nullable().optional()
});

const volume = z.enum(['standard', 'high_flow', 'tpu_high_flow', 'e3d_high_flow']);

const extruder = z.number().int().min(0).max(1);

export const kProfileQuery = z.strictObject({
	filamentId: z.string().max(40).optional(),
	/** Whose nozzle size to list (default: the main nozzle's). */
	extruderId: extruder.optional()
});

export const kProfileSave = z.strictObject({
	name: z.string().trim().min(1, 'Name the profile.').max(40),
	kValue: z.number().min(0).max(10),
	filamentId: z.string().min(1, 'Pick a filament.').max(40),
	settingId: z.string().max(80).default(''),
	tray: z.number().int().min(0).max(255).nullable().default(null),
	caliIdx: z.number().int().min(-1).nullable().default(null),
	/** Default: the extruder feeding `tray`, else a tray holding that filament. */
	extruderId: extruder.optional(),
	/** Default: that extruder's nozzle. */
	nozzleVolume: volume.optional(),
	/** An automatic result's n_coef, kept when it is saved as a profile. */
	nCoef: z.number().min(0).max(10).optional()
});

export const kProfileSelect = z.strictObject({
	tray: z.number().int().min(0).max(255),
	caliIdx: z.number().int().min(-1),
	filamentId: z.string().max(40)
});

export const kProfileDelete = z.strictObject({
	caliIdx: z.number().int().min(0),
	filamentId: z.string().max(40),
	extruderId: extruder.default(0),
	/** The profile's own (from its nozzle id); default: that extruder's nozzle. */
	nozzleVolume: volume.optional()
});

export const printerCalibStart = z.strictObject({
	kind: z.enum(['pa', 'flow']),
	trays: z.array(z.number().int().min(0).max(255)).min(1, 'Pick a tray.').max(16)
});

export const printerResultQuery = z.strictObject({
	kind: z.enum(['pa', 'flow']),
	/** Whose nozzle size to ask for (default: the main nozzle's). */
	extruderId: extruder.optional()
});

export const calibSettings = z.strictObject({
	/** The family project calibration prints go into (created on first use). */
	projectId: z.string().max(80).nullable()
});
