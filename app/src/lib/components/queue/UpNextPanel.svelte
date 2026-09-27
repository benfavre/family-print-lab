<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { duration } from '$lib/client/format';
	import { useQueue } from '$lib/client/modules/queue/store.svelte';
	import { queueActions, upNextFor, STATUS_LABEL } from '$lib/client/modules/queue/actions';
	import type { PrinterStatus } from '$lib/shared/domain';

	// The printer page's "Up next": what the queue starts on this printer next, and the plate button.
	let { printer }: { printer: PrinterStatus } = $props();
	const { lab } = useApp();
	const queue = useQueue(lab);
	const act = queueActions(lab);
	const me = $derived(queue.view?.printers.find((p) => p.printerId === printer.id) ?? null);
	const next = $derived(printer.id ? upNextFor(queue.view, printer.id, printer.model) : []);
</script>

{#if me && (next.length || me.plateClearNeeded)}
	<section class="panel up-next" aria-label="Up next">
		<header class="panel-head">
			<h2>Up next</h2>
			<span class="count">{next.length}</span>
		</header>
		{#if me.plateClearNeeded}
			<div class="plate">
				<span
					>A print finished here. Take it off and check the plate is clear before the next one.</span
				>
				<button
					class="mini primary-mini"
					onclick={() =>
						act.printer(me.printerId, { plateCleared: true }, 'Thanks. The next print can start.')}
					>Plate is clear</button
				>
			</div>
		{/if}
		<ol class="next-list">
			{#each next.slice(0, 4) as item (item.id)}
				<li>
					<span
						><b>{item.title}</b>{#if item.minutes}<small>&nbsp;· {duration(item.minutes)}</small
							>{/if}
						<small class="why"
							>{item.status === 'waiting'
								? (item.waitingFor ?? 'Starts next.')
								: `${STATUS_LABEL[item.status]}${item.reason ? `: ${item.reason}` : ''}`}</small
						></span
					>
				</li>
			{/each}
		</ol>
		<p class="foot">
			{me.blocked ?? (me.autoDispatch ? 'Starts by itself.' : 'Starts when you press Start next.')}
			<a href={resolve('/queue')}>Open the queue</a>
		</p>
	</section>
{/if}

<style>
	.plate {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		margin-bottom: 8px;
		border: 1px solid color-mix(in srgb, var(--amber) 45%, transparent);
		border-radius: var(--r-md);
		font-size: 13px;
	}
	.next-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.next-list li {
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		font-size: 13px;
	}
	.next-list small {
		color: var(--dim);
	}
	.why {
		display: block;
	}
	.foot {
		margin: 8px 0 0;
		font-size: 12px;
		color: var(--muted);
	}
</style>
