<script lang="ts">
	import { stamp } from '$lib/client/format';
	import type { MaintenanceData } from './overview.svelte';

	// What was done and when, newest first, with the print hours at the time.
	let { data }: { data: MaintenanceData } = $props();
	const log = $derived(data.overview?.log ?? []);
</script>

<section class="panel">
	<h2 class="panel-title">Log</h2>
	{#if !log.length}
		<p class="panel-empty">
			Nothing logged yet. Tasks you mark done and nozzle changes show up here.
		</p>
	{:else}
		<ul class="log">
			{#each log as e (e.id)}
				<li>
					<span
						><b>{e.label}</b>{#if e.note}<small>{e.note}</small>{/if}</span
					>
					<span class="when"
						>{stamp(e.doneAt)}{#if e.hoursAt !== null}<small>{e.hoursAt.toFixed(1)} h</small
							>{/if}</span
					>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.log {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 4px;
	}
	.log li {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		padding: 6px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
	}
	.log li:last-child {
		border-bottom: 0;
	}
	.log span {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.when {
		text-align: right;
		color: var(--muted);
		white-space: nowrap;
	}
	small {
		color: var(--dim);
		font-size: 12px;
	}
</style>
