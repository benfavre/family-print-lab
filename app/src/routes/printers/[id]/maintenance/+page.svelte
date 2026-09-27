<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import TaskList from '$lib/components/maintenance/TaskList.svelte';
	import MaintenanceLog from '$lib/components/maintenance/MaintenanceLog.svelte';
	import OdometerPanel from '$lib/components/maintenance/OdometerPanel.svelte';
	import NozzlePanel from '$lib/components/maintenance/NozzlePanel.svelte';
	import FirmwarePanel from '$lib/components/maintenance/FirmwarePanel.svelte';
	import { MaintenanceData } from '$lib/components/maintenance/overview.svelte';

	// One printer's maintenance: tasks from the Bambu Lab wiki and your own, the log, print hours,
	// nozzles and firmware.
	const { lab } = useApp();
	const id = $derived(page.params.id ?? '');
	const info = $derived(lab.ws.printers.find((p) => p.id === id));
	const p = $derived(lab.printerById(id));
	const data = new MaintenanceData(lab, () => id);
	$effect(() => {
		void id;
		return data.watch();
	});
	const o = $derived(data.overview);
	const due = $derived(o?.tasks.filter((t) => t.due.state === 'due').length ?? 0);
	const soon = $derived(o?.tasks.filter((t) => t.due.state === 'soon').length ?? 0);
</script>

<svelte:head><title>Maintenance · {info?.name ?? 'Printer'} · Family Print Lab</title></svelte:head>

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
				eyebrow="MAINTENANCE · {p.modelName ?? info.model}"
				title={p.name ?? 'Printer'}
				text={!o
					? 'Loading…'
					: due
						? `${due} ${due === 1 ? 'task is' : 'tasks are'} due.`
						: soon
							? `${soon} ${soon === 1 ? 'task is' : 'tasks are'} due soon.`
							: 'Nothing is due.'}
				note="Intervals from the Bambu Lab wiki; change them to suit how much you print"
			>
				{#snippet extra()}
					<StatTiles
						label="Maintenance"
						items={[
							{
								label: 'Print hours',
								value: o ? o.odometer.totalHours.toFixed(1) : '—',
								p: 0,
								tone: 'Planned'
							},
							{
								label: 'Due',
								value: o ? due : '—',
								p: o?.tasks.length ? due / o.tasks.length : 0,
								tone: 'Failed'
							},
							{
								label: 'Due soon',
								value: o ? soon : '—',
								p: o?.tasks.length ? soon / o.tasks.length : 0,
								tone: 'Printing'
							},
							{
								label: 'Firmware',
								value: p.state?.upgrade.available ? 'Update' : (p.state?.firmware.version ?? '—'),
								p: 0,
								tone: 'Done'
							}
						]}
					/>
				{/snippet}
			</PageHero>
			<nav class="crumbs" aria-label="Printer pages">
				<a href={resolve('/printers/[id]', { id })}>← {p.name}</a>
			</nav>
			{#if data.error}<p class="error">{data.error}</p>{/if}
			<div class="detail">
				<div class="detail-main">
					<TaskList {data} />
					<MaintenanceLog {data} />
				</div>
				<aside class="detail-side">
					<OdometerPanel {data} />
					<NozzlePanel printer={p} {data} />
					<FirmwarePanel printer={p} releaseNotes={o?.releaseNotes ?? null} />
				</aside>
			</div>
		{/if}
	</div>
</div>

<style>
	.crumbs {
		margin: 0 0 12px;
		font-size: 13px;
	}
	.crumbs a {
		color: var(--text-2);
		text-decoration: none;
	}
</style>
