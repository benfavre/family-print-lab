<script lang="ts">
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import Workbench from '$lib/components/workbench/Workbench.svelte';

	const { lab } = useApp();
	const model = $derived(lab.ws.models.find((m) => m.id === page.params.modelId));
</script>

<svelte:head><title>{model?.name ?? 'Model'} · Family Print Lab</title></svelte:head>

{#key page.params.modelId}
	<Workbench modelId={page.params.modelId!} />
{/key}
