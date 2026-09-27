import { json } from '@sveltejs/kit';
import { api } from '$lib/server/http';
import { workspaceOf } from '$lib/server/modules/slicer-ui/module';

/** Which backend slices and what it can do (the workspace hides what it cannot). */
export const GET = api(async (_e, rt) => json(await workspaceOf(rt).info()));
