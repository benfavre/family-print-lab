import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { parseStl } from '$lib/server/cad/mesh';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';
import { booleanMesh } from '$lib/server/modules/slicer-ui/boolean';
import type { Transform } from '$lib/shared/slicer/project';
const operand = z.strictObject({
	meshId: z.string().regex(/^[0-9a-f]{64}$/),
	transform: z.array(z.number().finite().min(-1e6).max(1e6)).length(12)
});
const body = z.strictObject({
	first: operand,
	second: operand,
	mode: z.enum(['union', 'subtract', 'intersect'])
});
export const POST = api(async ({ request }, rt) => {
	const input = parse(body, await readJson(request));
	const store = projectStore(rt);
	const soup = await booleanMesh(
		parseStl(store.meshStl(input.first.meshId)),
		parseStl(store.meshStl(input.second.meshId)),
		input.first.transform as Transform,
		input.second.transform as Transform,
		input.mode
	);
	return json({ mesh: store.putMesh(soup) });
});
