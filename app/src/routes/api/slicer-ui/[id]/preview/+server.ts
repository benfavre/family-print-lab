import { api } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { workspaceOf } from '$lib/server/modules/slicer-ui/module';
import { plateQuery } from '$lib/server/modules/slicer-ui/validation';

/** A sliced plate's toolpaths (the preview container of shared/slicer/preview.ts). */
export const GET = api(({ params, url }, rt) => {
	const { plate } = parse(plateQuery, Object.fromEntries(url.searchParams));
	const bytes = workspaceOf(rt).preview(params.id!, plate);
	return new Response(new Uint8Array(bytes), {
		headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }
	});
});
