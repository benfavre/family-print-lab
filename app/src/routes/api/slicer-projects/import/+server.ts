import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { readBinary } from '$lib/server/cad/requests';
import { MESH_FORMATS, type MeshFormat } from '$lib/server/cad/mesh';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';
import { MAX_PROJECT_BYTES } from '$lib/server/slicer3mf/store';

/**
 * Imports a Bambu Studio, OrcaSlicer, PrusaSlicer or plain 3MF (raw body) as a slicer project of
 * ?projectId=, named ?name= (the file name). ?format=stl or obj starts a project from one mesh.
 */
export const POST = api(async ({ request, url }, rt) => {
	const format = (url.searchParams.get('format') ?? '3mf').toLowerCase();
	if (!MESH_FORMATS.includes(format as MeshFormat))
		throw new AppError(400, 'Upload a 3MF project, or an STL or OBJ model.');
	const buf = await readBinary(request, MAX_PROJECT_BYTES);
	const { summary, warnings } = projectStore(rt).importFile(
		url.searchParams.get('projectId') ?? '',
		(url.searchParams.get('name') ?? '').slice(0, 200),
		buf,
		format as MeshFormat
	);
	return { slicerProject: summary, warnings };
});
