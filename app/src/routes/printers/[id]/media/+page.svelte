<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import MediaBrowser from '$lib/components/camera/MediaBrowser.svelte';

	// A printer's timelapses and the other files on its storage.
	const { lab } = useApp();
	const id = $derived(page.params.id ?? '');
	const p = $derived(lab.printerById(id));
</script>

<svelte:head><title>Media · {p?.name ?? 'Printer'} · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		<a class="back" href={resolve('/printers/[id]', { id })}>← {p?.name ?? 'Printer'}</a>
		<section class="panel">
			<header class="panel-head">
				<h2>Timelapses and files</h2>
			</header>
			{#if !p}
				<p class="panel-empty">That printer is not here.</p>
			{:else}
				{#key id}<MediaBrowser printerId={id} connected={!!p.connected} />{/key}
			{/if}
		</section>
	</div>
</div>

<style>
	.back {
		display: inline-block;
		margin: 4px 0 12px;
		font-size: 13px;
		color: var(--text-2);
		text-decoration: none;
	}
</style>
