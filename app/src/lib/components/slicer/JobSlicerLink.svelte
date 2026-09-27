<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { openInSlicer } from '$lib/client/slicer/open';
	import type { Job } from '$lib/shared/domain';

	// A queued job's way into the slicer workspace: its model version as a new slicer project, for
	// plates, modifiers, painting and per-object settings the quick slice does not offer.
	let { job }: { job: Job } = $props();
	const app = useApp();
	const model = $derived(job.modelVersionId ? app.lab.versions.get(job.modelVersionId) : undefined);
	let busy = $state(false);

	async function open() {
		if (!model) return;
		busy = true;
		await openInSlicer(
			app,
			job.projectId,
			[{ modelId: model.m.id, versionId: model.v.id }],
			`${model.m.name} v${model.v.number}`
		);
		busy = false;
	}
</script>

{#if model}
	<button
		class="mini"
		disabled={busy}
		onclick={open}
		title="Plates, modifiers, painting and settings per object"
	>
		{busy ? 'Opening…' : '▦ Open in the slicer'}
	</button>
{/if}
