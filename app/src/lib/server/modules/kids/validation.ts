// Input schemas for the kids module's API.
import { z } from 'zod';
import { validTimeZone } from './windows';

const limit = (max: number) => z.number().int().min(0).max(max).nullable().default(null);

export const kidLimitsInput = z.strictObject({
	printsPerDay: limit(50),
	printsPerWeek: limit(200),
	gramsPerWeek: limit(10_000),
	gramsPerMonth: limit(40_000),
	needApprovalOverGrams: limit(1_000)
});

export const kidsSettingsSchema = z.object({
	snapshots: z.boolean().default(false),
	timeZone: z.string().max(64).refine(validTimeZone, 'Unknown time zone.').nullable().default(null),
	/** Finished prints the grown-up chose not to add a photo for (newest last, capped). */
	dismissed: z.array(z.string().max(80)).max(200).default([])
});
export type StoredKidsSettings = z.infer<typeof kidsSettingsSchema>;

export const kidsSettingsInput = z.strictObject({
	snapshots: z.boolean().optional(),
	timeZone: z.string().max(64).refine(validTimeZone, 'Unknown time zone.').nullable().optional()
});

export const galleryUpload = z
	.strictObject({
		jobId: z.string().max(80).nullable().default(null),
		profileId: z.string().max(80).nullable().default(null),
		caption: z.string().trim().max(200).default(''),
		/** A data URL or base64 (JPEG or WebP, at most 400 KB). */
		image: z.string().max(600_000)
	})
	.refine((v) => v.jobId || v.profileId, 'Say which print or which maker the photo is for.');

export const galleryPatch = z.strictObject({ caption: z.string().trim().max(200) });
