<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { useQueue } from '$lib/client/modules/queue/store.svelte';
	import { queueActions, STATUS_LABEL } from '$lib/client/modules/queue/actions';
	import type { Job } from '$lib/shared/domain';

	// The send panel's "Add to queue": line the job up instead of sending it now, for the chosen
	// printer or for any printer the file fits.
	let { job, printerId, plate }: { job: Job; printerId: string | null; plate: number } = $props();
	const { lab } = useApp();
	const queue = useQueue(lab);
	const act = queueActions(lab);
	const queued = $derived(queue.view?.items.find((i) => i.jobId === job.id) ?? null);
	const printerName = $derived(lab.printerById(printerId)?.name ?? 'this printer');
	let busy = $state(false);

	async function add(target: string | null) {
		busy = true;
		// The queue prints the job's chosen plate.
		if (job.sliced && plate !== job.sliced.plate)
			await lab.call('PATCH', `/api/jobs/${job.id}/sliced`, { plate });
		await act.add(
			{ jobId: job.id, printerId: target },
			target ? `Queued for ${printerName}.` : 'Queued for any printer that fits.'
		);
		busy = false;
	}
</script>

{#if queue.view}
	<div class="sq" aria-label="Add to queue">
		{#if queued}
			<span
				>In the queue{queued.printerId
					? ` for ${queue.view.printers.find((p) => p.printerId === queued.printerId)?.name ?? 'a printer'}`
					: ' for any printer'} · {STATUS_LABEL[queued.status]}{queued.waitingFor
					? ` · ${queued.waitingFor}`
					: ''}</span
			>
		{:else}
			<span>Or line it up to start by itself when a printer is free.</span>
			<div class="sq-acts">
				{#if printerId}
					<button type="button" class="mini" disabled={busy} onclick={() => add(printerId)}
						>Add to queue</button
					>
				{/if}
				<button type="button" class="mini" disabled={busy} onclick={() => add(null)}
					>Queue for any printer</button
				>
			</div>
		{/if}
	</div>
{/if}

<style>
	.sq {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px;
		padding: 8px 10px;
		border: 1px dashed var(--line-strong);
		border-radius: var(--r-md);
		font-size: 12.5px;
		color: var(--muted);
	}
	.sq-acts {
		display: flex;
		gap: 6px;
	}
</style>
