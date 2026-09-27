import { z } from 'zod';
import { PASSWORD_MAX, PASSWORD_MIN, PIN_PATTERN } from '$lib/shared/lan-auth';

/** Stored in meta under settings:lan-auth. The hash never leaves the server. */
export const authSettingsSchema = z.object({
	passwordHash: z.string().max(300).nullable(),
	profilePins: z.boolean(),
	requireLocal: z.boolean()
});
export type AuthSettings = z.infer<typeof authSettingsSchema>;
export const AUTH_DEFAULTS: AuthSettings = {
	passwordHash: null,
	profilePins: false,
	requireLocal: false
};

const current = z.string().max(PASSWORD_MAX).optional();

export const passwordSchema = z
	.string()
	.min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
	.max(PASSWORD_MAX, 'That password is too long.');

export const setPasswordInput = z.strictObject({ password: passwordSchema, current });
export const clearPasswordInput = z.strictObject({ current });
export const updateInput = z.strictObject({
	profilePins: z.boolean().optional(),
	requireLocal: z.boolean().optional(),
	current
});
export const pinInput = z.strictObject({
	pin: z.string().regex(PIN_PATTERN, 'Use 4 to 8 digits.')
});
export const loginInput = z.strictObject({
	secret: z.string().max(PASSWORD_MAX),
	next: z.string().max(2000).optional()
});
export const logoutInput = z.strictObject({ everywhere: z.boolean().optional() });
