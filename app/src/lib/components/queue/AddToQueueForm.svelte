<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { duration, fromLocalInput } from '$lib/client/format';
	import { queueActions } from '$lib/client/modules/queue/actions';
	import { modelShort, sameModel } from '$lib/shared/printers/models';
	import type { QueueView } from '$lib/shared/queue';

	// Adds a queued job with a sliced file to the queue: which column, from when, and the plate check.
	let { view }: { view: QueueView } = $props();
	const { lab } = useApp();
	const act = queueActions(lab);
	const inQueue = $derived(new Set(view.items.map((i) => i.jobId)));
	const ready = $derived(
		lab.ws.jobs.filter((j) => j.status === 'Queued' && j.sliced && !inQueue.has(j.id))
	);
	let jobId = $state('');
	let column = $state('any');
	let notBefore = $state('');
	// svelte-ignore state_referenced_locally
	let plate = $state(view.settings.requirePlateClear);
	const job = $derived(ready.find((j) => j.id === jobId) ?? null);
	const fits = (model: string) =>
		!job?.sliced?.printerModelId || sameModel(job.sliced.printerModelId, model);
	const label = (j: (typeof ready)[number]) => {
		const p = j.sliced?.plates.find((x) => x.index === j.sliced?.plate);
		return `${lab.project(j.projectId)?.title ?? 'Print'} ${j.revision}${p ? ` · ${duration(p.minutes)}` : ''}${j.sliced?.printerModelId ? ` · ${modelShort(j.sliced.printerModelId)}` : ''}`;
	};
	$effect(() => {
		if (!job) return;
		// The job's own printer when it has one.
		column = job.printerId ?? 'any';
	});

	async function add(e: SubmitEvent) {
		e.preventDefault();
		if (!job) return;
		const res = await act.add({
			jobId: job.id,
			printerId: column === 'any' ? null : column,
			notBefore: fromLocalInput(notBefore),
			requirePlateClear: plate
		});
		if (res) {
			jobId = '';
			notBefore = '';
		}
	}
</script>

<form class="panel add" onsubmit={add} aria-label="Add a job to the queue">
	<h2 class="panel-title">Add a job</h2>
	{#if ready.length}
		<div class="row">
			<label
				>Job
				<select bind:value={jobId} required>
					<option value="" disabled>Choose a sliced job…</option>
					{#each ready as j (j.id)}<option value={j.id}>{label(j)}</option>{/each}
				</select></label
			>
			<label
				>Printer
				<select bind:value={column}>
					<option value="any">Any printer</option>
					{#each view.printers as p (p.printerId)}
						<option value={p.printerId} disabled={!fits(p.model)}
							>{p.name}{fits(p.model) ? '' : ' (sliced for another model)'}</option
						>
					{/each}
				</select></label
			>
			<label
				>Not before
				<input type="datetime-local" bind:value={notBefore} />
			</label>
		</div>
		<label class="check"
			><input type="checkbox" bind:checked={plate} /> Wait until someone confirms the plate is clear</label
		>
		<div><button class="primary" disabled={!job}>Add to queue</button></div>
	{:else}
		<p class="panel-empty">
			Every queued job with a sliced file is already here. Attach a sliced file to a job on Print
			jobs to queue it.
		</p>
	{/if}
</form>

<style>
	.add {
		display: grid;
		gap: 10px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.row label {
		display: grid;
		gap: 4px;
		font-size: 12px;
		color: var(--muted);
		min-width: 180px;
		flex: 1;
	}
	.check {
		font-size: 13px;
	}
</style>
