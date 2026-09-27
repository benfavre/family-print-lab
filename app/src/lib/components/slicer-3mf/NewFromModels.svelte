<script lang="ts">
	import { goto } from '$app/navigation';
	import { useApp } from '$lib/client/app.svelte';
	import { workspaceHref } from '$lib/client/slicer/api';
	import type { SlicerProjectSummary } from '$lib/shared/slicer-3mf';

	let { projectId, oncreated }: { projectId: string; oncreated?: () => void } = $props();
	const { lab } = useApp();
	const models = $derived(
		lab.ws.models
			.filter((m) => m.projectId === projectId && m.currentVersionId)
			.sort((a, b) => a.name.localeCompare(b.name))
	);
	let chosen = $state<string[]>([]);
	let name = $state('');
	let busy = $state(false);
	// A different project: start over.
	$effect(() => {
		void projectId;
		chosen = [];
	});

	async function create() {
		busy = true;
		const versions = models
			.filter((m) => chosen.includes(m.id))
			.map((m) => ({ modelId: m.id, versionId: m.currentVersionId! }));
		const res = await lab.call<{ slicerProject: SlicerProjectSummary }>(
			'POST',
			'/api/slicer-projects',
			{ projectId, name: name.trim() || undefined, versions },
			'Slicer project started.'
		);
		busy = false;
		if (!res) return;
		chosen = [];
		name = '';
		oncreated?.();
		await goto(workspaceHref(projectId, res.slicerProject.id));
	}
</script>

<div class="new-from-models">
	{#if models.length}
		<fieldset>
			<legend>Models to put on the plate</legend>
			{#each models as m (m.id)}
				<label class="pick">
					<input type="checkbox" value={m.id} bind:group={chosen} />
					<span>{m.name}</span>
					<small>v{m.version}</small>
				</label>
			{/each}
		</fieldset>
		<label class="field"
			>Name <input
				type="text"
				bind:value={name}
				maxlength="120"
				placeholder="The model names"
			/></label
		>
		<button class="primary" disabled={busy || !chosen.length} onclick={create}
			>{busy ? 'Starting…' : 'Start slicer project'}</button
		>
	{:else}
		<p class="panel-empty">
			This project has no models yet. Add one on the project page, or import a 3MF here.
		</p>
	{/if}
</div>

<style>
	.new-from-models {
		display: grid;
		gap: 10px;
	}
	fieldset {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
		max-height: 220px;
		overflow: auto;
	}
	legend {
		padding: 0 4px;
		font-size: 12px;
		color: var(--muted);
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
	}
	.pick small {
		margin-left: auto;
		color: var(--dim);
	}
	.field {
		display: grid;
		gap: 4px;
		font-size: 12px;
		color: var(--muted);
	}
	.primary {
		justify-self: start;
	}
</style>
