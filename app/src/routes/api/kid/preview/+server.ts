import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { writeStl } from '$lib/server/cad/mesh';
import { needKid, previewThing } from '$lib/server/kid/things';

/** Renders a template with the child's choices without saving (the mesh as base64 STL). */
export const POST = api(async ({ request, locals }) => {
	const body = (await readJson(request, 20_000)) as { template?: unknown; params?: unknown };
	const { soup, ...preview } = await previewThing(needKid(locals.kid), body.template, body.params);
	return json({ ...preview, stl: writeStl(soup).toString('base64') });
});
