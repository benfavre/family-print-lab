<script lang="ts">
	import type { AnalyticsFilter, AnalyticsSummary } from '$lib/shared/analytics';
	import { NO_PRINTER } from '$lib/shared/analytics';
	import { RANGES, rangeDates, rangeOf } from './view';

	// One row above the charts: date range (presets or custom days), printer and person.
	let {
		filter = $bindable(),
		options,
		onexport
	}: {
		filter: AnalyticsFilter;
		options: AnalyticsSummary['options'] | null;
		onexport: () => void;
	} = $props();
	const range = $derived(rangeOf(filter.from, filter.to));
	let custom = $state(false);
	const showDates = $derived(custom || range === null);
</script>

<div class="stats-filters" role="group" aria-label="Filter statistics">
	<div class="status-tabs" role="group" aria-label="Date range">
		{#each RANGES as r (r.id)}
			<button
				class="status-tab"
				class:selected={!showDates && range === r.id}
				aria-pressed={!showDates && range === r.id}
				onclick={() => {
					custom = false;
					filter = { ...filter, ...rangeDates(r.id) };
				}}>{r.label}</button
			>
		{/each}
		<button
			class="status-tab"
			class:selected={showDates}
			aria-pressed={showDates}
			onclick={() => (custom = true)}>Dates…</button
		>
	</div>
	{#if showDates}
		<label class="pick"
			>From <input
				type="date"
				value={filter.from ?? ''}
				max={filter.to ?? undefined}
				onchange={(e) => (filter = { ...filter, from: e.currentTarget.value || null })}
			/></label
		>
		<label class="pick"
			>to <input
				type="date"
				value={filter.to ?? ''}
				min={filter.from ?? undefined}
				onchange={(e) => (filter = { ...filter, to: e.currentTarget.value || null })}
			/></label
		>
	{/if}
	{#if options && options.printers.length}
		<label class="pick"
			>Printer <select
				value={filter.printerId ?? ''}
				onchange={(e) => (filter = { ...filter, printerId: e.currentTarget.value || null })}
			>
				<option value="">All printers</option>
				{#each options.printers as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				<option value={NO_PRINTER}>No printer set</option>
			</select></label
		>
	{/if}
	{#if options && options.people.length > 1}
		<label class="pick"
			>Person <select
				value={filter.profileId ?? ''}
				onchange={(e) => (filter = { ...filter, profileId: e.currentTarget.value || null })}
			>
				<option value="">Everyone</option>
				{#each options.people as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select></label
		>
	{/if}
	<button
		class="secondary export"
		onclick={onexport}
		title="Every finished print in this view, for a spreadsheet">⤓ CSV</button
	>
</div>

<style>
	.stats-filters {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin: 4px 0 14px;
	}
	.pick {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--muted);
	}
	.pick select,
	.pick input {
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		padding: 5px 8px;
		font: inherit;
		color-scheme: inherit;
	}
	.pick select option {
		background: var(--menu);
	}
	.export {
		margin-left: auto;
	}
</style>
