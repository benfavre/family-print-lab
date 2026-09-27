<script lang="ts">
	import type { MaintenanceData } from './overview.svelte';

	// Print hours: jobs the app recorded on this printer plus hours it had before (editable).
	let { data }: { data: MaintenanceData } = $props();
	const odo = $derived(data.overview?.odometer ?? null);
	let editing = $state(false);
	let baseline = $state<number | null>(0);

	function edit() {
		baseline = odo?.baselineHours ?? 0;
		editing = true;
	}
	async function save(e: SubmitEvent) {
		e.preventDefault();
		const ok = await data.write(
			'PUT',
			'/odometer',
			{ baselineHours: typeof baseline === 'number' ? baseline : 0 },
			'Print hours saved.'
		);
		if (ok) editing = false;
	}
</script>

<section class="panel">
	<h2 class="panel-title">Print hours</h2>
	{#if odo}
		<dl class="facts">
			<div>
				<dt>Total</dt>
				<dd>{odo.totalHours.toFixed(1)} h</dd>
			</div>
			<div>
				<dt>Recorded here</dt>
				<dd>{odo.jobHours.toFixed(1)} h</dd>
			</div>
		</dl>
		{#if editing}
			<form class="baseline" onsubmit={save}>
				<label class="field"
					>Hours before this app<input
						type="number"
						min="0"
						max="100000"
						step="any"
						bind:value={baseline}
					/></label
				>
				<p class="hint">The printer shows its total print time under Settings on its screen.</p>
				<div class="row">
					<button class="mini primary-mini" type="submit">Save</button>
					<button class="mini" type="button" onclick={() => (editing = false)}>Cancel</button>
				</div>
			</form>
		{:else}
			<p class="hint">
				{odo.baselineHours
					? `Includes ${odo.baselineHours.toFixed(1)} h from before.`
					: 'Counts finished print jobs sent from here.'}
			</p>
			<button class="mini" onclick={edit}>Set earlier hours</button>
		{/if}
	{/if}
</section>

<style>
	.hint {
		color: var(--dim);
		font-size: 12px;
		margin: 8px 0;
	}
	.baseline {
		margin-top: 10px;
	}
	.row {
		display: flex;
		gap: 6px;
	}
</style>
