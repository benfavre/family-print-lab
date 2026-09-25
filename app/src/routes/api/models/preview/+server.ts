import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { preview } from '$lib/server/cad/requests';
import { parseParameters, renderScad } from '$lib/server/cad/openscad';
import { stats, writeStl } from '$lib/server/cad/mesh';

/** Renders OpenSCAD source without saving: diagnostics, parameters, size, and the mesh as base64 STL. */
export const POST = api(async ({ request }) => {
	const input = parse(preview, await readJson(request, 400_000));
	const { soup, ...render } = await renderScad(input.source, input.params);
	return json({
		...render,
		parameters: parseParameters(input.source),
		stats: soup ? stats(soup) : null,
		stl: soup ? writeStl(soup).toString('base64') : null
	});
});
