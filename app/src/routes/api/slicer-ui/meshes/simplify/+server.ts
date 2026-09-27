import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { parseStl } from '$lib/server/cad/mesh';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';
import { simplifyMesh } from '$lib/server/modules/slicer-ui/simplify-mesh';

const body = z.strictObject({
	meshId: z.string().regex(/^[0-9a-f]{64}$/),
	tolerance: z.number().finite().positive().max(10_000)
});

/** Store a new immutable mesh; the browser owns the undoable project edit. */
export const POST = api(async ({ request }, rt) => {
	const input = parse(body, await readJson(request));
	const store = projectStore(rt);
	const source = parseStl(store.meshStl(input.meshId));
	const simplified = await simplifyMesh(source, input.tolerance);
	const mesh = simplified ? store.putMesh(simplified) : store.meshRef(input.meshId);
	return json({ mesh, before: source.length / 9, after: mesh.triangles });
});
