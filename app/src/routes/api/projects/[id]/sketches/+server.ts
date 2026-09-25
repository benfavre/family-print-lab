import { api } from '$lib/server/http';
import { readBinary } from '$lib/server/cad/requests';

/** Adds a sketch (PNG request body) to a project. */
export const POST = api(async ({ request, params, url }, rt) => {
	const png = await readBinary(request, 4_000_000);
	return { id: rt.sketches.create(params.id!, png, url.searchParams.get('title') ?? '') };
});
