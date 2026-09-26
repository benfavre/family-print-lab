<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { UI } from '$lib/client/registry';
	import { trayLabel } from '$lib/shared/printing';
	import type { AmsUnit, PrinterStatus, PrinterTray } from '$lib/shared/domain';

	// The AMS units and external spools, with every registered tray action (Add to shelf, Load…).
	let { printer }: { printer: PrinterStatus } = $props();
	const app = useApp();
	const s = $derived(printer.state ?? null);
	const dual = $derived((s?.nozzles.length ?? 1) > 1);
	const unitName = (u: AmsUnit) =>
		u.model === 'AMS HT'
			? `AMS HT ${u.id - 127}`
			: u.id === 16
				? 'AMS Lite'
				: `${u.model === 'Unknown' ? 'AMS' : u.model} ${u.id + 1}`;
	const humidity = (u: AmsUnit) =>
		u.humidityPercent !== null
			? `humidity ${u.humidityPercent}%`
			: u.humidityIndex !== null
				? `humidity level ${u.humidityIndex}`
				: '';
	const actionsFor = (t: PrinterTray) => UI.trayActions.filter((a) => a.show?.(t, printer) ?? true);
</script>

{#snippet tray(t: PrinterTray)}
	<div class="ams-slot" class:active={t.active} class:vacant={!t.type} data-tray={t.global}>
		<span
			class="swatch big"
			style:--swatch={t.color}
			data-swatch={t.color ? '' : undefined}
			aria-hidden="true"
		></span>
		<strong>{t.type || 'Empty'}</strong>
		<small
			>{t.remain !== null
				? `${t.remain}% left`
				: t.type
					? 'amount unknown'
					: trayLabel(t.global, dual)}</small
		>
		{#if t.type}
			{#each actionsFor(t) as a (a.id)}
				<button class="mini" onclick={() => a.run({ tray: t, printer, app })}>{a.label}</button>
			{/each}
		{/if}
	</div>
{/snippet}

<section class="panel">
	<h2 class="panel-title">Filament</h2>
	{#each s?.ams ?? [] as unit (unit.id)}
		<div class="ams-unit">
			<header>
				<span>{unitName(unit)}</span>{#if humidity(unit)}<small>{humidity(unit)}</small>{/if}
			</header>
			<div class="ams-slots">
				{#each unit.trays as t (t.global)}{@render tray(t)}{/each}
			</div>
		</div>
	{/each}
	{#if s?.externalSpools.length}
		<div class="ams-unit">
			<header><span>External spool{s.externalSpools.length > 1 ? 's' : ''}</span></header>
			<div class="ams-slots">
				{#each s.externalSpools as t (t.global)}{@render tray(t)}{/each}
			</div>
		</div>
	{/if}
	{#if !s?.ams.length && !s?.externalSpools.length}
		<p class="panel-empty">No filament data reported.</p>
	{/if}
</section>
