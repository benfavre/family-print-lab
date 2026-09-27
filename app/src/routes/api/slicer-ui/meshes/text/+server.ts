import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { parseStl } from '$lib/server/cad/mesh';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';
import { textMesh } from '$lib/server/modules/slicer-ui/text';
import type { Transform } from '$lib/shared/slicer/project';
const finite = z.number().finite().min(-1e6).max(1e6);
const vector = z.tuple([finite, finite, finite]);
const body = z.strictObject({
	meshId: z.string().regex(/^[0-9a-f]{64}$/),
	transform: z.array(finite).length(12),
	text: z
		.string()
		.trim()
		.min(1)
		.max(60)
		.refine((s) => [...s].every((c) => c.charCodeAt(0) >= 32), 'Use one line of printable text.'),
	font: z.enum(['bold', 'regular', 'mono']),
	size: z.number().finite().min(2).max(200),
	depth: z.number().finite().min(0.2).max(20),
	mode: z.enum(['emboss', 'engrave']),
	point: vector,
	normal: vector.refine((n) => Math.hypot(...n) > 1e-6, 'Choose a face direction.'),
	angle: z.number().finite().min(-360).max(360)
});
export const POST = api(async ({ request }, rt) => {
	const input = parse(body, await readJson(request));
	const store = projectStore(rt);
	const soup = await textMesh(parseStl(store.meshStl(input.meshId)), {
		...input,
		transform: input.transform as Transform
	});
	return json({ mesh: store.putMesh(soup) });
});
