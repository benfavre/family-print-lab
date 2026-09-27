<script lang="ts">
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { download } from '$lib/client/actions';
	import { duration, money, weight } from '$lib/client/format';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import Filters from '$lib/components/analytics/Filters.svelte';
	import Dashboard from '$lib/components/analytics/Dashboard.svelte';
	import { percent, rangeDates } from '$lib/components/analytics/view';
	import { filterParams, type AnalyticsFilter, type AnalyticsSummary } from '$lib/shared/analytics';

	const { lab } = useApp();

	// The filter lives in the address (?from&to&printer&person, range=all for all time) so a reload or
	// a shared link keeps it; with no dates it shows the last 12 months.
	const q = page.url.searchParams;
	const dates =
		q.get('range') === 'all'
			? rangeDates('all')
			: q.has('from') || q.has('to')
				? { from: q.get('from') || null, to: q.get('to') || null }
				: rangeDates('12m');
	let filter = $state<AnalyticsFilter>({
		...dates,
		printerId: q.get('printer'),
		profileId: q.get('person'),
		tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
	});
	let summary = $state<AnalyticsSummary | null>(null);
	let error = $state('');
	let loading = $state(false);

	const query = $derived(filterParams(filter).toString());
	$effect(() => {
		// Refetch when the filter changes, and when a job changes anywhere (the workspace moves on).
		void lab.ws.changeId;
		const params = query;
		const controller = new AbortController();
		loading = true;
		fetch(`/api/analytics?${params}`, { signal: controller.signal })
			.then(async (r) => {
				const body = await r.json().catch(() => ({}));
				if (!r.ok) throw new Error(body.error ?? 'Could not load the statistics.');
				summary = body;
				error = '';
			})
			.catch((e: Error) => {
				if (e.name === 'AbortError') return;
				error =
					e instanceof TypeError
						? 'Could not reach Family Print Lab. Check it is still running, then try again.'
						: e.message;
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});
	$effect(() => {
		const params = filterParams({ ...filter, tz: undefined });
		if (!filter.from && !filter.to) params.set('range', 'all');
		const search = params.toString();
		if (`?${search}` !== page.url.search && (search || page.url.search))
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- a resolve() path plus the filter
			replaceState(`${resolve('/analytics')}${search ? `?${search}` : ''}`, page.state);
	});

	const t = $derived(summary?.totals);
</script>

<svelte:head><title>Stats · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		<PageHero
			eyebrow="HOW THE LAB IS DOING"
			title="Stats"
			text="Success rate, filament and its cost, printer hours and what went wrong, from your finished print jobs. Worked out on this computer."
			note="Preview animation"
		>
			{#snippet extra()}
				<StatTiles
					label="Totals for this view"
					items={[
						{ label: 'Prints', value: t?.prints ?? '—', p: 1, tone: 'Planned' },
						{
							label: 'Worked',
							value: percent(t?.successRate ?? null),
							p: t?.successRate ?? 0,
							tone: 'Done'
						},
						{ label: 'Filament', value: weight(t?.grams), p: 1, tone: 'Printing' },
						{ label: 'Cost', value: money(t?.cost), p: 1, tone: 'Idea' },
						{ label: 'Printer time', value: duration(t?.machineMinutes), p: 1, tone: 'Planned' },
						{ label: 'Average print', value: duration(t?.averageMinutes), p: 1, tone: 'Done' }
					]}
				/>
			{/snippet}
		</PageHero>
		<Filters
			bind:filter
			options={summary?.options ?? null}
			onexport={() => download(`/api/analytics/export.csv?${query}`)}
		/>
		{#if error}
			<p class="stats-error" role="alert">{error}</p>
		{/if}
		{#if summary}
			{#if t && t.uncostedGrams > 0}
				<p class="stats-note">
					{weight(t.uncostedGrams)} of filament has no spool price, so it is not in the cost. Add a price
					to the spool on the Filament shelf.
				</p>
			{/if}
			<div class:loading aria-busy={loading}><Dashboard s={summary} /></div>
		{:else if !error}
			<p class="panel-empty">Adding up your prints…</p>
		{/if}
	</div>
</div>

<style>
	.loading {
		opacity: 0.6;
		transition: opacity 0.2s;
	}
	.stats-error {
		margin: 0 0 12px;
		color: var(--err-text);
		font-size: 13px;
	}
	.stats-note {
		margin: 0 0 12px;
		font-size: 12.5px;
		color: var(--muted);
	}
</style>
