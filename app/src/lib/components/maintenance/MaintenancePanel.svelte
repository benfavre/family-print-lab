<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { dueLabel } from '$lib/shared/maintenance';
	import type { PrinterStatus } from '$lib/shared/domain';
	import { MaintenanceData } from './overview.svelte';

	// Printer page side panel: print hours, and the tasks that are due or nearly due, one tap to mark done.
	let { printer }: { printer: PrinterStatus } = $props();
	const { lab } = useApp();
	// A derived id, so status updates (a new printer object every report) do not reload this.
	const id = $derived(printer.id ?? '');
	const data = new MaintenanceData(lab, () => id);
	$effect(() => {
		void id;
		return data.watch();
	});
	const o = $derived(data.overview);
	const pressing = $derived(
		(o?.tasks ?? []).filter((t) => t.due.state === 'due' || t.due.state === 'soon')
	);
	const shown = $derived(pressing.slice(0, 4));
	const hasUpdate = $derived(!!printer.state?.upgrade.available);
</script>

<section class="panel" data-maintenance-panel>
	<header class="panel-head">
		<h2>Maintenance</h2>
		{#if o}<span class="count">{o.odometer.totalHours.toFixed(1)} print hours</span>{/if}
	</header>
	{#if data.error}
		<p class="panel-empty">{data.error}</p>
	{:else if !o}
		<p class="panel-empty">Loading…</p>
	{:else if !shown.length}
		<p class="panel-empty">Nothing due. {o.tasks.length} tasks tracked.</p>
	{:else}
		<ul class="due-list">
			{#each shown as t (t.id)}
				<li class:overdue={t.due.state === 'due'}>
					<span><b>{t.label}</b><small>{dueLabel(t.due)}</small></span>
					<button class="mini" onclick={() => data.done(t.id)} aria-label="Mark {t.label} done"
						>✓ Done</button
					>
				</li>
			{/each}
		</ul>
		{#if pressing.length > shown.length}
			<p class="panel-empty">And {pressing.length - shown.length} more.</p>
		{/if}
	{/if}
	{#if hasUpdate}
		<p class="update">
			Firmware {printer.state?.upgrade.version ?? ''} is available. Update it from the printer or Bambu
			Handy.
		</p>
	{/if}
	<a class="mini" href={resolve('/printers/[id]/maintenance', { id })}>All maintenance</a>
</section>

<style>
	.due-list {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.due-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		font-size: 13px;
	}
	.due-list li.overdue {
		border-color: color-mix(in srgb, var(--amber) 60%, var(--line));
	}
	.due-list span {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.due-list small {
		color: var(--dim);
	}
	.overdue small {
		color: var(--amber);
	}
	.update {
		font-size: 13px;
		color: var(--text-2);
		margin: 0 0 10px;
	}
</style>
