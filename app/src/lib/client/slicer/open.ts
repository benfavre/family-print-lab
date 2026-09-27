// "Open in the slicer" from elsewhere in the app: a new slicer project holding model versions, then the
// workspace. Used by the model menu and the job card.
import { goto } from '$app/navigation';
import type { AppContext } from '../app.svelte';
import type { SlicerProjectSummary } from '$lib/shared/slicer-3mf';
import { resolve } from '$app/paths';

export async function openInSlicer(
	app: AppContext,
	projectId: string,
	versions: { modelId: string; versionId: string }[],
	name?: string
) {
	const r = await app.lab.call<{ slicerProject: SlicerProjectSummary }>(
		'POST',
		'/api/slicer-projects',
		{ projectId, versions, name }
	);
	if (r)
		await goto(
			resolve('/projects/[id]/slicer/[slicerProjectId]', {
				id: projectId,
				slicerProjectId: r.slicerProject.id
			})
		);
}
