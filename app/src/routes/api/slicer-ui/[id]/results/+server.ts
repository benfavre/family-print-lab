import { json } from '@sveltejs/kit';
import { api } from '$lib/server/http';
import { workspaceOf } from '$lib/server/modules/slicer-ui/module';

/** The sliced plates kept for this project, with the revision each came from. */
export const GET = api(({ params }, rt) => json(workspaceOf(rt).results(params.id!)));
