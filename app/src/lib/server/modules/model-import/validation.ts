// Request bodies for the model-import routes.
import { z } from 'zod';

const link = z.string().trim().min(1, 'Paste a link.').max(1000);

export const previewInput = z.strictObject({ url: link });

export const confirmInput = z.strictObject({
	url: link,
	projectId: z.string().max(80).nullish(),
	profileId: z.string().max(80).nullish(),
	files: z.array(z.string().max(80)).max(50).default([]),
	pictures: z.boolean().optional()
});

export const settingsInput = z.strictObject({
	/** A new token, '' to remove it; leave out to keep the saved one. */
	thingiverseToken: z
		.string()
		.trim()
		.max(200)
		.regex(/^[\w.-]*$/, 'That does not look like a token.')
		.optional()
});

/** Stored in meta (settings:model-import); the token never goes back to the browser. */
export const storedSettings = z.object({ thingiverseToken: z.string().max(200) });
