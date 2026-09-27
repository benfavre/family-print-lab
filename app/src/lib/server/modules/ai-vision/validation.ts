// Schemas for the AI check: settings, the provider's answer, and the API's inputs.
import { z } from 'zod';
import { AI_PROVIDERS } from '$lib/shared/integrations';
import { VISION_VERDICTS, type VisionSettings } from '$lib/shared/vision';

export const visionSettingsSchema: z.ZodType<VisionSettings> = z.strictObject({
	enabled: z.boolean(),
	method: z.enum(['local', ...AI_PROVIDERS]),
	everyLayers: z.number().int().min(1).max(1000).nullable(),
	everyMinutes: z.number().int().min(1).max(240).nullable(),
	threshold: z.number().min(0.5).max(0.99),
	autoPause: z.boolean(),
	printers: z.record(z.string().max(80), z.boolean())
});

/** A settings change from the page: any subset of the fields (printers is managed per printer). */
export const visionSettingsInput = z.strictObject({
	enabled: z.boolean().optional(),
	method: z.enum(['local', ...AI_PROVIDERS]).optional(),
	everyLayers: z.number().int().min(1).max(1000).nullable().optional(),
	everyMinutes: z.number().int().min(1).max(240).nullable().optional(),
	threshold: z.number().min(0.5).max(0.99).optional(),
	autoPause: z.boolean().optional()
});

export const printerToggleInput = z.strictObject({ enabled: z.boolean() });

/**
 * The answer we ask every provider for. Providers get it as a JSON schema (structured output); we
 * still validate what comes back, because a CLI can return anything.
 */
export const verdictSchema = z.object({
	verdict: z.enum(VISION_VERDICTS),
	confidence: z.number().min(0).max(1),
	reason: z.string().trim().min(1).max(600)
});
export type ProviderVerdict = z.infer<typeof verdictSchema>;

/** The same shape as a JSON schema, for StructuredRequest.schema (kept to what all three accept). */
export const VERDICT_JSON_SCHEMA: Record<string, unknown> = {
	type: 'object',
	additionalProperties: false,
	required: ['verdict', 'confidence', 'reason'],
	properties: {
		verdict: { type: 'string', enum: [...VISION_VERDICTS] },
		confidence: {
			type: 'number',
			description: 'How sure you are of the verdict, from 0 to 1.'
		},
		reason: {
			type: 'string',
			description: 'One or two short sentences a parent can read: what you see.'
		}
	}
};

export const listQuery = z.object({
	before: z.string().max(40).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50)
});
