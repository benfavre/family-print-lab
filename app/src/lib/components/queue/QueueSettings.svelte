<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { useQueue } from '$lib/client/modules/queue/store.svelte';
	import { queueActions } from '$lib/client/modules/queue/actions';
	import { WEEKDAYS, type QueueSettings } from '$lib/shared/queue';

	// Integrations → Print queue: quiet hours per weekday and the plate check default.
	const { lab } = useApp();
	const queue = useQueue(lab);
	const act = queueActions(lab);
	let draft = $state<QueueSettings | null>(null);
	$effect(() => {
		if (queue.view && !draft) draft = structuredClone($state.snapshot(queue.view.settings));
	});
	// Monday first, as a week reads in the UK.
	const ORDER = [1, 2, 3, 4, 5, 6, 0];
	let saving = $state(false);

	async function save() {
		if (!draft) return;
		saving = true;
		const res = await act.settings($state.snapshot(draft));
		if (res?.queue) draft = structuredClone(res.queue.settings);
		saving = false;
	}
	function copyToAll(day: number) {
		if (!draft) return;
		const w = draft.quietHours[day];
		draft.quietHours = draft.quietHours.map(() => ({ ...w }));
	}
</script>

<section class="int-section" id="queue" aria-label="Print queue">
	<h2>Print queue</h2>
	<p class="section-lead">
		Queued jobs start by themselves when a printer is free. Quiet hours stop them starting at night
		or whenever the house should be quiet; a print that is already running carries on.
	</p>
	{#if draft}
		<form
			class="qs"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<table>
				<thead>
					<tr
						><th scope="col">Day</th><th scope="col">Quiet from</th><th scope="col">until</th><th
						></th></tr
					>
				</thead>
				<tbody>
					{#each ORDER as day (day)}
						{@const w = draft.quietHours[day]}
						<tr class:off={!w.on}>
							<th scope="row"
								><label class="check"
									><input
										type="checkbox"
										bind:checked={w.on}
										aria-label="Quiet hours on {WEEKDAYS[day]}"
									/>
									{WEEKDAYS[day]}</label
								></th
							>
							<td
								><input
									type="time"
									bind:value={w.start}
									disabled={!w.on}
									aria-label="{WEEKDAYS[day]} quiet from"
								/></td
							>
							<td
								><input
									type="time"
									bind:value={w.end}
									disabled={!w.on}
									aria-label="{WEEKDAYS[day]} quiet until"
								/></td
							>
							<td
								><button type="button" class="mini" onclick={() => copyToAll(day)}
									>Same every day</button
								></td
							>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="hint">An end before the start runs past midnight (21:00 until 07:00).</p>
			<label class="check"
				><input type="checkbox" bind:checked={draft.requirePlateClear} /> New queue items wait until someone
				confirms the plate is clear</label
			>
			<div><button class="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
		</form>
	{:else if queue.error}
		<p class="panel-empty">{queue.error}</p>
	{/if}
</section>

<style>
	.qs {
		display: grid;
		gap: 10px;
		max-width: 620px;
		font-size: 13px;
	}
	table {
		border-collapse: collapse;
	}
	th,
	td {
		text-align: left;
		padding: 4px 8px 4px 0;
		font-weight: 450;
	}
	thead th {
		color: var(--dim);
		font-size: 12px;
	}
	tr.off td input {
		opacity: 0.5;
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--dim);
	}
</style>
