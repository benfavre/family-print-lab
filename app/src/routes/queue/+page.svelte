<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { useQueue } from '$lib/client/modules/queue/store.svelte';
	import { open } from '$lib/client/modules/queue/actions';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import QueueBoard from '$lib/components/queue/QueueBoard.svelte';
	import QueueTimeline from '$lib/components/queue/QueueTimeline.svelte';
	import AddToQueueForm from '$lib/components/queue/AddToQueueForm.svelte';

	const { lab } = useApp();
	const queue = useQueue(lab);
	const view = $derived(queue.view);
	const items = $derived(open(view));
	const waiting = $derived(items.filter((i) => i.status === 'waiting').length);
	const held = $derived(items.filter((i) => i.status === 'held' || i.status === 'failed').length);
	const plates = $derived(view?.printers.filter((p) => p.plateClearNeeded).length ?? 0);
	let show = $state<'board' | 'timeline'>('board');
</script>

<svelte:head><title>Queue · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		<PageHero
			context={{ kind: 'printer' }}
			eyebrow="LINED UP"
			title="Queue"
			text="Line up sliced jobs for one printer or for any printer that fits. Each one starts by itself when its printer is free, once someone confirms the plate is clear."
			note="Preview animation"
		>
			{#snippet actions()}
				<a class="secondary button-link" href="{resolve('/integrations')}#queue">Quiet hours</a>
			{/snippet}
			{#snippet extra()}
				<StatTiles
					label="Queue totals"
					items={[
						{
							label: 'Waiting',
							value: waiting,
							p: items.length ? waiting / items.length : 0,
							tone: 'Idea'
						},
						{
							label: 'On hold',
							value: held,
							p: items.length ? held / items.length : 0,
							tone: 'Failed'
						},
						{
							label: 'Plates to clear',
							value: plates,
							p: view?.printers.length ? plates / view.printers.length : 0,
							tone: 'Printing'
						}
					]}
				/>
			{/snippet}
		</PageHero>

		{#if !view}
			<p class="panel-empty">{queue.error || 'Loading the queue…'}</p>
		{:else if !view.printers.length}
			<section class="panel">
				<h2 class="panel-title">No printers yet</h2>
				<p class="panel-empty">
					The queue sends jobs to your printers. Add one in Integrations → Printers first.
				</p>
				<a class="primary button-link" href="{resolve('/integrations')}#printers">Add a printer</a>
			</section>
		{:else}
			{#if view.quietNow}<p class="quiet-note">
					Quiet hours: nothing starts by itself right now.
				</p>{/if}
			<div class="bar">
				<div class="segmented" role="tablist" aria-label="Show">
					<button
						role="tab"
						aria-selected={show === 'board'}
						class:active={show === 'board'}
						onclick={() => (show = 'board')}>Columns</button
					>
					<button
						role="tab"
						aria-selected={show === 'timeline'}
						class:active={show === 'timeline'}
						onclick={() => (show = 'timeline')}>Timeline</button
					>
				</div>
			</div>
			{#if show === 'board'}
				<QueueBoard {view} />
			{:else}
				<section class="panel"><QueueTimeline {view} /></section>
			{/if}
			<div class="add-wrap"><AddToQueueForm {view} /></div>
		{/if}
	</div>
</div>

<style>
	.button-link {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}
	.bar {
		margin: 4px 0 12px;
	}
	.segmented {
		display: flex;
		gap: 4px;
	}
	.segmented button {
		padding: 6px 12px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
	}
	.segmented button.active {
		color: var(--text);
		border-color: var(--cyan);
		background: rgb(var(--raise));
	}
	.quiet-note {
		margin: 0 0 8px;
		font-size: 13px;
		color: var(--amber);
	}
	.add-wrap {
		margin-top: 12px;
	}
</style>
