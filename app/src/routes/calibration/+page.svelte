<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { settingsAnchor } from '$lib/client/onboarding';
	import { CalibrationData } from '$lib/client/modules/slicer-calibration/store.svelte';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import CalibrationWizard from '$lib/components/calibration/CalibrationWizard.svelte';
	import RunCard from '$lib/components/calibration/RunCard.svelte';

	// Calibration: tests made by Print Lab Slicer (OrcaSlicer's generators), printed through the queue,
	// read with the help of a drawing, and saved into the filament preset the spool slices with.
	const { lab } = useApp();
	const data = new CalibrationData(lab);
	$effect(() => data.watch());
	const o = $derived(data.overview);
	const runs = $derived(o?.runs ?? []);
	const waiting = $derived(runs.filter((r) => r.status === 'ready').length);
	const done = $derived(runs.filter((r) => r.status === 'done').length);
	const offline = $derived(!!o && o.tests.every((t) => !t.available));
	// The slicer is there but the profiles are not: a different fix, so a different heading.
	const noProfiles = $derived(!!o?.engine && /profiles/.test(o.tests[0]?.reason ?? ''));
</script>

<svelte:head><title>Calibration · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		<PageHero
			context={{ kind: 'printer' }}
			eyebrow="TUNE EACH FILAMENT"
			title="Calibration"
			text="Print a small test, pick the best result, and every later print with that spool uses it. Flow rate, pressure advance, temperature, retraction and speed."
			note="Tests ported from OrcaSlicer's Calibration menu (AGPL-3.0, by the OrcaSlicer authors)"
		>
			{#snippet actions()}
				{#if page.url.searchParams.get('printer')}
					<a
						class="secondary button-link"
						href={resolve('/printers/[id]/calibration', {
							id: page.url.searchParams.get('printer')!
						})}>The printer’s own calibration</a
					>
				{/if}
			{/snippet}
			{#snippet extra()}
				<StatTiles
					label="Calibration"
					items={[
						{
							label: 'To read',
							value: waiting,
							p: runs.length ? waiting / runs.length : 0,
							tone: 'Printing'
						},
						{
							label: 'Saved',
							value: done,
							p: runs.length ? done / runs.length : 0,
							tone: 'Done'
						}
					]}
				/>
			{/snippet}
		</PageHero>

		{#if data.error}<p class="load-error" role="alert">{data.error}</p>{/if}
		{#if offline}
			<section class="panel">
				<h2 class="panel-title">
					{noProfiles ? 'Needs the slicer profiles' : 'Needs Print Lab Slicer'}
				</h2>
				<p class="panel-empty">{o?.tests[0]?.reason}</p>
				<a
					class="mini"
					href="{resolve('/integrations')}#{noProfiles
						? settingsAnchor('slicer-profiles')
						: 'integration-slicer'}">See Integrations</a
				>
			</section>
		{/if}

		<CalibrationWizard {data} printerId={page.url.searchParams.get('printer') ?? ''} />

		{#if runs.length}
			<h2 class="section">Your tests</h2>
			<div class="runs">
				{#each runs as run (run.id)}
					<RunCard {run} {data} queue={!!o?.queue} />
				{/each}
			</div>
		{:else if o}
			<p class="panel-empty none">No tests yet. Start with flow rate, then pressure advance.</p>
		{:else if !data.error}
			<p class="panel-empty none">Loading…</p>
		{/if}
	</div>
</div>

<style>
	.button-link {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}
	.load-error {
		margin: 0 0 8px;
		font-size: 13px;
		color: var(--err-text);
	}
	.section {
		font-size: 14px;
		margin: 18px 0 8px;
	}
	.runs {
		display: grid;
		gap: 10px;
	}
	.none {
		margin-top: 12px;
	}
	.layout :global(.panel) {
		margin-bottom: 10px;
	}
</style>
