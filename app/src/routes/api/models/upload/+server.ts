import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { MESH_FORMATS, type MeshFormat } from '$lib/server/cad/mesh';
import { readBinary } from '$lib/server/cad/requests';

/** Imports an STL, 3MF or OBJ file (raw request body) as a new mesh model. */
export const POST = api(async ({ request, url }, rt) => {
	const format = (url.searchParams.get('format') ?? '').toLowerCase();
	if (!MESH_FORMATS.includes(format as MeshFormat))
		throw new AppError(400, 'Upload an STL, 3MF or OBJ file.');
	const buf = await readBinary(request, 100_000_000);
	const id = rt.models.importFile(
		url.searchParams.get('projectId') ?? '',
		url.searchParams.get('name') ?? '',
		buf,
		format as MeshFormat
	);
	return { id };
});
