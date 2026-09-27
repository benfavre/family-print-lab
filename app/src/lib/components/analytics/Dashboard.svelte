<script lang="ts">
	import { duration, money, weight } from '$lib/client/format';
	import { projectHref } from '$lib/client/actions';
	import type { AnalyticsSummary } from '$lib/shared/analytics';
	import Line from '$lib/components/charts/Line.svelte';
	import Bars from '$lib/components/charts/Bars.svelte';
	import StackedBars from '$lib/components/charts/StackedBars.svelte';
	import Donut from '$lib/components/charts/Donut.svelte';
	import Sparkline from '$lib/components/charts/Sparkline.svelte';
	import { materialTones, monthlyStacks, OTHER, percent, PERSON_TONE, weekLabel } from './view';

	// The statistics panels for one summary.
	let { s }: { s: AnalyticsSummary } = $props();
	const colours = $derived(materialTones(s));
	const stacks = $derived(monthlyStacks(s.months, colours.tones, colours.other));
	const materialItems = $derived.by(() => {
		const used = s.byMaterial.filter((m) => m.grams > 0);
		const top = used
			.filter((m) => colours.tones.has(m.key))
			.map((m) => ({
				key: m.key,
				label: m.label,
				value: m.grams,
				tone: colours.tones.get(m.key)!
			}));
		const rest = used.filter((m) => !colours.tones.has(m.key));
		return rest.length
			? [
					...top,
					{
						key: OTHER,
						label: `${OTHER} (${rest.map((m) => m.label).join(', ')})`,
						value: rest.reduce((n, m) => n + m.grams, 0),
						tone: 'dim' as const
					}
				]
			: top;
	});
	const personColour = $derived(new Map(s.options.people.map((p) => [p.id, PERSON_TONE[p.color]])));
	const costHint = (cost: number | null, uncosted: number) =>
		[cost !== null ? `cost ${money(cost)}` : '', uncosted > 0 ? `${weight(uncosted)} unpriced` : '']
			.filter(Boolean)
			.join(' · ');
	const weekHint = (w: AnalyticsSummary['weeks'][number]) =>
		`${w.succeeded} of ${w.succeeded + w.failed} worked${w.cancelled ? ` · ${w.cancelled} cancelled` : ''}`;
	const hasWeeks = $derived(s.weeks.some((w) => w.rate !== null));
</script>

<div class="stats-grid">
	<section class="panel wide">
		<div class="panel-head">
			<h2>Success rate by week</h2>
			{#if s.weeks.length > 1}
				<span class="count"
					><Sparkline
						values={s.weeks.map((w) => w.succeeded + w.failed + w.cancelled)}
						label="Finished prints per week"
						tone="violet"
					/> prints a week</span
				>
			{/if}
		</div>
		{#if hasWeeks}
			<Line
				label="Share of prints that worked, per week (cancelled prints left out)"
				points={s.weeks.map((w) => ({
					label: weekLabel(w.week),
					value: w.rate,
					hint: w.rate === null ? undefined : weekHint(w)
				}))}
				max={1}
				format={(v) => percent(v)}
				tone="lime"
			/>
			<p class="note">Cancelled prints are left out. Weeks start on Monday.</p>
		{:else}
			<p class="panel-empty">No finished prints in this view yet.</p>
		{/if}
	</section>

	<section class="panel wide">
		<h2 class="panel-title">Filament by month</h2>
		{#if stacks.columns.length}
			<StackedBars
				label="Filament used per month, by material"
				columns={stacks.columns}
				series={stacks.series}
				values={stacks.values}
				format={weight}
			/>
		{:else}
			<p class="panel-empty">No filament used in this view.</p>
		{/if}
	</section>

	<section class="panel">
		<h2 class="panel-title">By material</h2>
		{#if materialItems.length}
			<Donut
				label="Filament by material"
				items={materialItems}
				format={weight}
				center={weight(s.totals.grams)}
			/>
		{:else}
			<p class="panel-empty">No filament used in this view.</p>
		{/if}
	</section>

	<section class="panel">
		<h2 class="panel-title">By person</h2>
		{#if s.byPerson.length}
			<Bars
				label="Filament by project owner"
				items={s.byPerson.map((p) => ({
					key: p.key,
					label: p.label,
					value: p.grams,
					tone: personColour.get(p.key),
					hint: costHint(p.cost, p.uncostedGrams)
				}))}
				format={weight}
			/>
		{:else}
			<p class="panel-empty">No prints in this view.</p>
		{/if}
	</section>

	<section class="panel">
		<h2 class="panel-title">By printer</h2>
		{#if s.byPrinter.length}
			<Bars
				label="Filament by printer"
				items={s.byPrinter.map((p) => ({
					key: p.key,
					label: p.label,
					value: p.grams,
					hint: costHint(p.cost, p.uncostedGrams)
				}))}
				format={weight}
			/>
		{:else}
			<p class="panel-empty">No prints in this view.</p>
		{/if}
	</section>

	<section class="panel">
		<h2 class="panel-title">Printer hours</h2>
		{#if s.hours.length}
			<Bars
				label="Printing time per printer"
				items={s.hours.map((h) => ({
					key: h.key,
					label: h.label,
					value: h.minutes,
					hint: `${h.prints} ${h.prints === 1 ? 'print' : 'prints'}`
				}))}
				format={duration}
				tone="blue"
			/>
		{:else}
			<p class="panel-empty">No printing time in this view.</p>
		{/if}
	</section>

	<section class="panel">
		<h2 class="panel-title">Why prints failed</h2>
		{#if s.failures.length}
			<Bars
				label="Failure reasons"
				items={s.failures.map((f) => ({ key: f.reason, label: f.reason, value: f.count }))}
				tone="red"
			/>
			<p class="note">
				{s.printerErrors
					? 'From the printer’s error reports, or the job notes when the printer said nothing.'
					: 'From the notes on failed jobs.'}
			</p>
		{:else}
			<p class="panel-empty">No failed prints in this view.</p>
		{/if}
	</section>

	<section class="panel">
		<h2 class="panel-title">Top projects</h2>
		{#if s.topProjects.length}
			<table class="top">
				<thead>
					<tr><th>Project</th><th>Prints</th><th>Worked</th><th>Filament</th><th>Cost</th></tr>
				</thead>
				<tbody>
					{#each s.topProjects as p (p.id)}
						<tr>
							<td
								><a href={projectHref(p.id)}>{p.title}</a>
								<small>{p.owner}</small></td
							>
							<td>{p.prints}</td>
							<td>{p.succeeded}</td>
							<td>{weight(p.grams)}</td>
							<td>{money(p.cost)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="panel-empty">No finished prints in this view.</p>
		{/if}
	</section>
</div>

<style>
	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
		gap: 12px;
	}
	.wide {
		grid-column: 1 / -1;
	}
	.note {
		margin: 10px 0 0;
		font-size: 11.5px;
		color: var(--dim);
	}
	.top {
		width: 100%;
		border-collapse: collapse;
		font-size: 12.5px;
		font-variant-numeric: tabular-nums;
	}
	.top th {
		padding: 0 6px 6px;
		font-weight: 500;
		font-size: 11.5px;
		color: var(--dim);
		text-align: right;
	}
	.top td {
		padding: 6px;
		border-top: 1px solid var(--line);
		text-align: right;
	}
	.top th:first-child,
	.top td:first-child {
		padding-left: 0;
		text-align: left;
	}
	.top a {
		color: var(--text);
		text-decoration: none;
	}
	.top a:hover {
		text-decoration: underline;
	}
	.top small {
		display: block;
		color: var(--dim);
		font-size: 11px;
	}
</style>
