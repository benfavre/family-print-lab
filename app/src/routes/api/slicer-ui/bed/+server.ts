import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { workspaceOf } from '$lib/server/modules/slicer-ui/module';
import { presetRefBody } from '$lib/server/modules/slicer-ui/validation';

/** The printable area and height of a printer preset (the workspace draws its beds from it). */
export const POST = api(async ({ request }, rt) =>
	json(workspaceOf(rt).bed(parse(presetRefBody, await readJson(request))))
);
