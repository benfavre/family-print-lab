import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { readBinary } from '$lib/server/cad/requests';
import { MESH_FORMATS, type MeshFormat } from '$lib/server/cad/mesh';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';
import { meshFromModel } from '$lib/server/modules/slicer-3mf/validation';

/**
 * Adds a mesh to the store for a project to use: JSON { modelId, versionId } takes a model version,
 * a raw STL, OBJ or 3MF body (?format=) an upload. Answers the MeshRef (its id is the sha256).
 */
export const POST = api(async ({ request, url }, rt) => {
	const store = projectStore(rt);
	if ((request.headers.get('content-type') ?? '').startsWith('application/json')) {
		const { modelId, versionId } = parse(meshFromModel, await readJson(request));
		return json({ mesh: store.putModelVersion(modelId, versionId) });
	}
	const format = (url.searchParams.get('format') ?? '').toLowerCase();
	if (!MESH_FORMATS.includes(format as MeshFormat))
		throw new AppError(400, 'Upload an STL, 3MF or OBJ file.');
	return json({
		mesh: store.putUpload(await readBinary(request, 100_000_000), format as MeshFormat)
	});
});
