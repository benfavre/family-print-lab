<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import VisionHistory from '$lib/components/vision/VisionHistory.svelte';
	import { scheduleText, VisionData } from '$lib/components/vision/vision.svelte';

	// One printer's AI checks: what each check saw, with its picture, and Check now.
	const { lab } = useApp();
	const id = $derived(page.params.id ?? '');
	const info = $derived(lab.ws.printers.find((p) => p.id === id));
	const p = $derived(lab.printerById(id));
	const data = new VisionData(lab, () => id);
	$effect(() => {
		void id;
		return data.watch();
	});
	const o = $derived(data.overview);
	const recent = $derived(o?.recent ?? []);
	const problems = $derived(recent.filter((c) => c.alerted).length);
</script>

<svelte:head><title>AI checks · {info?.name ?? 'Printer'} · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		{#if !info || !p}
			<section class="panel">
				<h2 class="panel-title">That printer is not here</h2>
				<p class="panel-empty">
					It may have been removed in <a href="{resolve('/integrations')}#printers"
						>Integrations → Printers</a
					>.
				</p>
				<a class="mini" href={resolve('/printers')}>All printers</a>
			</section>
		{:else}
			<PageHero
				context={{ kind: 'printer' }}
				eyebrow="AI CHECKS · {p.modelName ?? info.model}"
				title={p.name ?? 'Printer'}
				text={!o
					? 'Loading…'
					: o.active
						? `${o.methodLabel}, ${scheduleText(o.settings)} while printing.`
						: o.settings.enabled
							? 'Automatic checks are off for this printer.'
							: 'Automatic checks are off.'}
				note={o?.settings.method === 'local'
					? 'The rough check only notices sudden changes in the picture'
					: 'Pictures are kept for 14 days'}
			>
				{#snippet extra()}
					<StatTiles
						label="AI checks"
						items={[
							{ label: 'Latest checks', value: o ? recent.length : '—', p: 0, tone: 'Planned' },
							{
								label: 'Alerts',
								value: o ? problems : '—',
								p: recent.length ? problems / recent.length : 0,
								tone: 'Failed'
							},
							{
								label: 'Alert at',
								value: o ? `${Math.round(o.settings.threshold * 100)}%` : '—',
								p: o?.settings.threshold ?? 0,
								tone: 'Printing'
							},
							{
								label: 'Pause when sure',
								value: o ? (o.settings.autoPause ? 'On' : 'Off') : '—',
								p: 0,
								tone: 'Done'
							}
						]}
					/>
				{/snippet}
			</PageHero>
			<nav class="crumbs" aria-label="Printer pages">
				<a href={resolve('/printers/[id]', { id })}>← {p.name}</a>
				<span class="actions">
					<button class="mini" onclick={() => data.checkNow()} disabled={data.running || !o?.camera}
						>{data.running ? 'Checking…' : 'Check now'}</button
					>
					<a class="mini" href="{resolve('/integrations')}#ai-vision">Settings</a>
				</span>
			</nav>
			{#if data.error}<p class="error">{data.error}</p>{/if}
			<VisionHistory {data} />
		{/if}
	</div>
</div>

<style>
	.crumbs {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin: 0 0 12px;
		font-size: 13px;
	}
	.crumbs a:first-child {
		color: var(--text-2);
		text-decoration: none;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
</style>
