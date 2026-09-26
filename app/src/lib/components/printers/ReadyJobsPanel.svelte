<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { duration } from '$lib/client/format';
	import { sameModel } from '$lib/shared/printers/models';
	import type { PrinterStatus } from '$lib/shared/domain';

	// Queued jobs with a sliced file that fits this printer, one click from printing.
	let { printer }: { printer: PrinterStatus } = $props();
	const { lab, ui } = useApp();
	const ready = $derived(
		lab.ws.jobs.filter(
			(j) =>
				j.status === 'Queued' &&
				j.sliced &&
				(!j.printerId || j.printerId === printer.id) &&
				(!j.sliced.printerModelId ||
					!printer.model ||
					sameModel(j.sliced.printerModelId, printer.model))
		)
	);
</script>

{#if ready.length}
	<section class="panel">
		<header class="panel-head">
			<h2>Ready to send</h2>
			<span class="count">{ready.length}</span>
		</header>
		<ul class="ready-list" aria-label="Ready to send">
			{#each ready as j (j.id)}
				{@const plate = j.sliced?.plates.find((x) => x.index === j.sliced?.plate)}
				<li data-job={j.id}>
					<span
						><b>{lab.project(j.projectId)?.title}</b>
						{j.revision}{#if plate}<small>&nbsp;· {duration(plate.minutes)} · {plate.grams} g</small
							>{/if}</span
					>
					<button class="mini primary-mini" onclick={() => ui.openSend(j.id, printer.id)}
						>▣ Send</button
					>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.ready-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.ready-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		font-size: 13px;
	}
	.ready-list small {
		color: var(--dim);
	}
</style>
