<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { useApp } from '$lib/client/app.svelte';
	import { duration, printerStateLabel, temp } from '$lib/client/format';
	import { UI } from '$lib/client/registry';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';

	// One printer: its live state, and every registered printer panel and sub-page link.
	const { lab } = useApp();
	const id = $derived(page.params.id ?? '');
	const info = $derived(lab.ws.printers.find((p) => p.id === id));
	const p = $derived(lab.printerById(id));
	const s = $derived(p?.state ?? null);
	const active = $derived(lab.printerActiveFor(id));
	const label = $derived(p ? printerStateLabel(p) : '');
	const linked = $derived(
		s?.task
			? lab.ws.jobs.find(
					(j) =>
						j.status === 'Printing' &&
						j.printerTask === s.task &&
						(!j.printerId || j.printerId === id)
				)
			: undefined
	);
	const focus = $derived(linked ? (lab.project(linked.projectId)?.category ?? 'Home') : 'Home');
	const progress = $derived(
		active && s?.percent !== null && s?.percent !== undefined
			? s.percent / 100
			: s?.gcodeState === 'FINISH'
				? 1
				: null
	);
	const panels = $derived(p ? UI.printerPanels.filter((x) => x.show?.(p) ?? true) : []);
	const tabs = $derived(p ? UI.printerTabs.filter((x) => x.show?.(p) ?? true) : []);
	const others = $derived(lab.printerList);
</script>

<svelte:head><title>{info?.name ?? 'Printer'} · Family Print Lab</title></svelte:head>

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
				eyebrow={p.simulated
					? 'SIMULATED PRINTER · FOR DEVELOPMENT'
					: `LIVE PRINTER · ${p.modelName ?? info.model}`}
				title={p.name ?? 'Printer'}
				text={!p.connected
					? p.enabled === false
						? 'Switched off in Integrations → Printers.'
						: p.error || 'Waiting for the printer…'
					: s?.task && active
						? `${label}: ${s.task}`
						: label}
				{focus}
				{progress}
				note={active
					? 'Live progress from the printer · representative shape'
					: 'Representative shape — not the model on the plate'}
			>
				{#snippet extra()}
					<StatTiles
						label="Printer status"
						items={[
							{
								label: 'Progress',
								value: s?.percent !== null && s?.percent !== undefined ? `${s.percent}%` : '—',
								p: (s?.percent ?? 0) / 100,
								tone: 'Printing'
							},
							{
								label: 'Layer',
								value: s?.layer ?? '—',
								p: s?.totalLayers ? (s.layer ?? 0) / s.totalLayers : 0,
								tone: 'Planned'
							},
							{
								label: 'Time left',
								value:
									active && s?.remainingMinutes !== null && s?.remainingMinutes !== undefined
										? duration(s.remainingMinutes)
										: '—',
								p: 0,
								tone: 'Idea'
							},
							{
								label: 'Nozzle',
								value: temp(s?.nozzle),
								p: s?.nozzle ? Math.min(s.nozzle / 300, 1) : 0,
								tone: 'Done'
							}
						]}
					/>
				{/snippet}
			</PageHero>
			{#if others.length > 1}
				{#if others.length <= 4}
					<nav class="switcher" aria-label="Printers">
						{#each others as o (o.id)}
							<a
								href={resolve('/printers/[id]', { id: o.id ?? '' })}
								aria-current={o.id === id ? 'page' : undefined}
								class:live={!!o.id && lab.printerActiveFor(o.id)}>{o.name}</a
							>
						{/each}
					</nav>
				{:else}
					<label class="switcher-select"
						><span>Printer</span><select
							value={id}
							onchange={(e) => goto(resolve('/printers/[id]', { id: e.currentTarget.value }))}
						>
							{#each others as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
						</select></label
					>
				{/if}
			{/if}
			{#if tabs.length}
				<nav class="printer-tabs" aria-label="{p.name} pages">
					<!-- eslint-disable svelte/no-navigation-without-resolve -- packages build these hrefs with resolve() -->
					{#each tabs as t (t.id)}<a href={t.href(id)}>{t.label}</a>{/each}
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				</nav>
			{/if}
			<div class="section-meta">
				<span
					>{p.simulated
						? 'Connected to the printer simulator — control it at http://127.0.0.1:8766'
						: ''}</span
				><span>Commands are sent only when you press a button here or send a job</span>
			</div>
			<div class="detail">
				<div class="detail-main">
					{#each panels.filter((x) => x.column === 'main') as panel (panel.id)}
						<panel.component printer={p} {info} />
					{/each}
				</div>
				<aside class="detail-side">
					{#each panels.filter((x) => x.column === 'side') as panel (panel.id)}
						<panel.component printer={p} {info} />
					{/each}
				</aside>
			</div>
		{/if}
	</div>
</div>

<style>
	.switcher,
	.printer-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0 0 12px;
	}
	.switcher a,
	.printer-tabs a {
		padding: 5px 12px;
		border-radius: 999px;
		border: 1px solid var(--line);
		font-size: 13px;
		color: var(--text-2);
		text-decoration: none;
	}
	.switcher a[aria-current='page'] {
		border-color: var(--cyan);
		color: var(--text);
	}
	.switcher a.live::after {
		content: ' ●';
		color: var(--amber);
	}
	.switcher-select {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
	}
</style>
