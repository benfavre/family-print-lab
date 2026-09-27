// Slicer project calls (slicer-3mf) that do not fit LabStore.call: lists and details that return data,
// file uploads, and pure helpers for showing a Project.
import { resolve } from '$app/paths';
import type { SlicerProjectDetail, SlicerProjectSummary } from '$lib/shared/slicer-3mf';
import type { PartType, Project } from '$lib/shared/slicer/project';

export const SLICER_ACCEPT = '.3mf,.stl,.obj';
export const slicerProjectHref = (id: string) => resolve('/slicer-projects/[id]', { id });
export const slicerFileUrl = (id: string) => `/api/slicer-projects/${id}/file`;

async function read<T>(response: Response): Promise<T> {
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
	return data as T;
}

export async function listSlicerProjects(projectId?: string): Promise<SlicerProjectSummary[]> {
	const q = projectId ? `?${new URLSearchParams({ projectId })}` : '';
	return (
		await read<{ slicerProjects: SlicerProjectSummary[] }>(await fetch(`/api/slicer-projects${q}`))
	).slicerProjects;
}

export async function getSlicerProject(id: string): Promise<SlicerProjectDetail> {
	return read<SlicerProjectDetail>(await fetch(`/api/slicer-projects/${id}`));
}

/** Uploads a 3MF project (or an STL/OBJ model) as a new slicer project of `projectId`. */
export async function importSlicerFile(projectId: string, file: File) {
	const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
	const format = ext === 'stl' || ext === 'obj' ? ext : '3mf';
	if (file.size > 100_000_000) throw new Error('Project files must be under 100 MB.');
	const params = new URLSearchParams({ projectId, name: file.name, format });
	return read<{ slicerProject: SlicerProjectSummary; warnings: string[] }>(
		await fetch(`/api/slicer-projects/import?${params}`, {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: file
		})
	);
}

export const PART_TYPE_LABEL: Record<PartType, string> = {
	model: 'Part',
	negative: 'Negative part',
	modifier: 'Modifier',
	support_blocker: 'Support blocker',
	support_enforcer: 'Support enforcer'
};

/** What a project uses, for the summary line and badges. */
export function projectFacts(p: Project) {
	const parts = p.objects.flatMap((o) => o.parts);
	const painted = (k: 'supports' | 'seam' | 'color' | 'fuzzySkin') =>
		parts.some((x) => x.paint?.[k] && Object.keys(x.paint[k]!).length);
	return {
		instances: p.objects.reduce((n, o) => n + o.instances.length, 0),
		triangles: parts.reduce((n, x) => n + (p.meshes[x.mesh]?.triangles ?? 0), 0),
		modifiers: parts.filter((x) => x.type !== 'model').length,
		heightRanges: p.objects.reduce((n, o) => n + o.heightRanges.length, 0),
		variableLayers: p.objects.some((o) => o.layerHeightProfile?.length),
		painting: [
			painted('supports') && 'supports',
			painted('seam') && 'seam',
			painted('color') && 'colour',
			painted('fuzzySkin') && 'fuzzy skin'
		].filter((x): x is string => !!x)
	};
}

/** A filament colour as CSS ('#RRGGBBAA' from Bambu becomes '#RRGGBB'), or null when it is not one. */
export function filamentCss(color: string): string | null {
	const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
	return m ? `#${m[1]}` : null;
}

export const fileSize = (bytes: number) =>
	bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
