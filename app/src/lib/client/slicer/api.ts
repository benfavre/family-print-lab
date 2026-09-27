// The slicer workspace's calls to the server that return data (lab.call covers the rest): the backend,
// beds, kept results, meshes, and uploads of new meshes.
import { resolve } from '$app/paths';
import { parseStl } from '../stl';
import type { MeshRef } from '$lib/shared/slicer/project';
import type { BedShape, ResultsView, SlicerBackend } from '$lib/shared/slicer-ui';
import type { PresetRef } from '$lib/shared/slicer/project';

async function read<T>(response: Response): Promise<T> {
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
	return data as T;
}

const post = (url: string, body: unknown) =>
	fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});

export const getBackend = async () => read<SlicerBackend>(await fetch('/api/slicer-ui/info'));

export const getBed = async (printer: PresetRef) =>
	read<BedShape>(await post('/api/slicer-ui/bed', printer));

export const getResults = async (id: string) =>
	read<ResultsView>(await fetch(`/api/slicer-ui/${id}/results`));

export const previewUrl = (id: string, plate: number) =>
	`/api/slicer-ui/${id}/preview?plate=${plate}`;
export const slicedUrl = (id: string, plate: number) =>
	`/api/slicer-ui/${id}/sliced?plate=${plate}`;

const meshes = new Map<string, Promise<Float32Array>>();

/** A stored mesh's triangles (content-addressed, so cached for the page's life). */
export function loadMesh(id: string): Promise<Float32Array> {
	let p = meshes.get(id);
	if (!p) {
		p = fetch(`/api/slicer-projects/meshes/${id}`).then(async (r) => {
			if (!r.ok) throw new Error('A mesh of this project could not be loaded.');
			return parseStl(await r.arrayBuffer());
		});
		p.catch(() => meshes.delete(id));
		meshes.set(id, p);
	}
	return p;
}

/** Stores a mesh (an upload, or a generated shape) and answers its reference. */
export async function putMesh(body: ArrayBuffer | Blob, format: string): Promise<MeshRef> {
	const r = await fetch(`/api/slicer-projects/meshes?format=${format}`, {
		method: 'POST',
		headers: { 'content-type': 'application/octet-stream' },
		body
	});
	return (await read<{ mesh: MeshRef }>(r)).mesh;
}

/** Stores a model version's mesh. */
export async function putModelMesh(modelId: string, versionId: string): Promise<MeshRef> {
	return (
		await read<{ mesh: MeshRef }>(await post('/api/slicer-projects/meshes', { modelId, versionId }))
	).mesh;
}

export const workspaceHref = (projectId: string, slicerProjectId: string) =>
	resolve('/projects/[id]/slicer/[slicerProjectId]', { id: projectId, slicerProjectId });
