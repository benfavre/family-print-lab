import { api } from '$lib/server/http';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';

/** A stored mesh as binary STL (content-addressed, so it never changes). */
export const GET = api(({ params }, rt) => {
	const stl = projectStore(rt).meshStl(params.meshId!);
	return new Response(new Uint8Array(stl), {
		headers: {
			'content-type': 'model/stl',
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
});
