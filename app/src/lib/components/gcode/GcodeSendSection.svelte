<script lang="ts">
	import type { Job } from '$lib/shared/domain';
	import GcodePreview from './GcodePreview.svelte';

	// In the send panel: the chosen plate's toolpaths, folded away until asked for (it loads the plate).
	let { job, plate }: { job: Job; plate: number } = $props();
	let open = $state(false);
	const info = $derived(job.sliced?.plates.find((p) => p.index === plate) ?? null);
</script>

{#if job.sliced && info}
	<div class="gs">
		<button
			type="button"
			class="mini"
			aria-expanded={open}
			onclick={() => (open = !open)}
			title="See every move of plate {plate} before sending"
			>◫ {open ? 'Hide toolpaths' : 'Show toolpaths'}</button
		>
		{#if open}
			<GcodePreview jobId={job.id} file={job.sliced.file} {plate} grams={info.grams} compact />
		{/if}
	</div>
{/if}

<style>
	.gs {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		margin: 4px 0 12px;
	}
	.gs > :global(.gp) {
		align-self: stretch;
	}
</style>
