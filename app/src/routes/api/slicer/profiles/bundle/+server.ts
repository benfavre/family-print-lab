import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';
import { configMap, presetRef } from '$lib/server/modules/slicer-profiles/validation';
import { parse } from '$lib/server/validation';
import type { PresetSelection } from '$lib/shared/slicer/project';

const body = z.strictObject({
	selection: z.strictObject({
		printer: presetRef,
		process: presetRef,
		filaments: z.array(presetRef).min(1).max(32)
	}),
	overrides: z
		.strictObject({
			printer: configMap.optional(),
			process: configMap.optional(),
			filaments: z.array(configMap).max(32).optional()
		})
		.default({})
});

/** The flat config a selection slices with (no workspace: nothing changes). */
export const POST = api(async ({ request }, rt) => {
	const b = parse(body, await readJson(request));
	return json(profilesOf(rt).profiles.bundle(b.selection as PresetSelection, b.overrides));
});
