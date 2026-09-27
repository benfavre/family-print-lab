import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { parseStl } from '$lib/server/cad/mesh';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';
import { cutMesh } from '$lib/server/modules/slicer-ui/mesh-tools';
import type { Transform } from '$lib/shared/slicer/project';

const body = z.strictObject({
	meshId: z.string().regex(/^[0-9a-f]{64}$/),
	transform: z.array(z.number().finite().min(-1e6).max(1e6)).length(12),
	axis: z.enum(['x', 'y', 'z']),
	at: z.number().finite().min(-1e6).max(1e6),
	keep: z.enum(['below', 'above', 'both'])
});

/** Returns new immutable meshes. The browser applies the cut as one undoable project edit. */
export const POST = api(async ({ request }, rt) => {
	const input = parse(body, await readJson(request));
	const store = projectStore(rt);
	const pieces = await cutMesh(parseStl(store.meshStl(input.meshId)), {
		...input,
		transform: input.transform as Transform
	});
	return json({ pieces: pieces.map(({ side, soup }) => ({ side, mesh: store.putMesh(soup) })) });
});
