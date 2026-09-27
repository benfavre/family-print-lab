// Request schemas for the slicer profile API.
import { z } from 'zod';

export const presetKind = z.enum(['printer', 'process', 'filament']);

/** Option keys as Bambu Studio writes them. */
const configKey = z.string().regex(/^[a-z][a-z0-9_]{0,99}$/, 'Not a setting name.');
/** G-code options can be long; nothing else comes close. */
const configText = z.string().max(100_000);
export const configValue = z.union([configText, z.array(configText).max(64)]);
export const configMap = z
	.record(configKey, configValue)
	.refine((m) => Object.keys(m).length <= 2000, 'Too many settings.');

/** Preset names: what Bambu Studio allows, without control characters or path separators. */
export const presetName = z
	.string()
	.trim()
	.min(1, 'Required')
	.max(120)
	// eslint-disable-next-line no-control-regex
	.refine((s) => !/[\u0000-\u001f\\/]/.test(s), 'Names cannot contain / or \\.');

export const presetRef = z.strictObject({
	kind: presetKind,
	name: z.string().min(1).max(200),
	source: z.enum(['system', 'user', 'project']),
	userPresetId: z.string().max(80).optional()
});

export const userPresetInput = z.strictObject({
	kind: presetKind,
	name: presetName,
	/** A system preset, or a user preset to copy (its own parent is kept, as Bambu Studio does). */
	from: presetRef.nullable().default(null),
	config: configMap.default({})
});

export const userPresetPatch = z.strictObject({
	version: z.number().int().positive(),
	name: presetName.optional(),
	/** The whole set of changed keys (replaces the stored ones). */
	config: configMap.optional()
});

export const jobSliceSettings = z.strictObject({
	printer: presetRef.nullable().optional(),
	process: presetRef.nullable().optional(),
	filaments: z.array(presetRef).max(32).nullable().optional(),
	overrides: z
		.strictObject({
			printer: configMap.optional(),
			process: configMap.optional(),
			filaments: z.array(configMap).max(32).optional()
		})
		.optional()
});

export const spoolPreset = z.strictObject({ preset: presetRef.nullable() });
