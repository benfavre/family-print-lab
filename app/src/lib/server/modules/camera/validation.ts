// Input checks for the camera routes.
import { z } from 'zod';
import type { CameraSettings } from '$lib/shared/camera';

export const cameraSettingsSchema: z.ZodType<CameraSettings> = z.object({
	showOnCards: z.boolean()
});

/** ?dir= for the file browser: an absolute path, checked again by safeFtpPath. */
export const mediaDirQuery = z.string().min(1).max(300).default('/timelapse');

/** ?path= for downloads. */
export const mediaPathQuery = z.string().min(2).max(300);
