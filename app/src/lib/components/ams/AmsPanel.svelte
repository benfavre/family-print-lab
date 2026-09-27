<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { amsLinks } from './links.svelte';
	import TrayDialog from './TrayDialog.svelte';
	import DryingDialog from './DryingDialog.svelte';
	import OptionsDialog from './OptionsDialog.svelte';
	import {
		DRY_STATUS,
		HUMIDITY_WORD,
		dryingRange,
		humidityLevel,
		matchTray,
		type AmsSpool
	} from '$lib/shared/ams';
	import { trayLabel } from '$lib/shared/printing';
	import type { AmsUnit, PrinterStatus, PrinterTray } from '$lib/shared/domain';

	// The AMS units and external spools with what each tray holds on the Filament shelf, humidity,
	// temperature and drying. Tapping a tray opens it: link, add to the shelf, settings, RFID re-read.
	let { printer }: { printer: PrinterStatus } = $props();
	const app = useApp();
	const { lab } = app;
	const id = $derived(printer.id!);
	const s = $derived(printer.state ?? null);
	const dual = $derived((s?.nozzles.length ?? 1) > 1);
	const spools = $derived(lab.ws.spools as AmsSpool[]);
	const amsState = $derived(amsLinks.states[id]);
	// Commands need the printer online; the trays stay readable from its last report.
	const online = $derived(!!printer.connected);

	$effect(() => amsLinks.watch(app, [id]));

	let open = $state<number | null>(null);
	let drying = $state<AmsUnit | null>(null);
	let options = $state(false);
	let busy = $state(false);

	const unitName = (u: AmsUnit) =>
		u.model === 'AMS HT'
			? `AMS HT ${u.id - 127}`
			: u.id === 16
				? 'AMS Lite'
				: `${u.model === 'Unknown' ? 'AMS' : u.model} ${u.id + 1}`;
	function climate(u: AmsUnit) {
		const level = humidityLevel(u);
		return [
			level !== null
				? `${HUMIDITY_WORD[level]}${u.humidityPercent !== null ? ` · ${u.humidityPercent}%` : ` · ${level}/5`}`
				: '',
			u.temp !== null && u.temp > 0 ? `${Math.round(u.temp)} °C` : ''
		]
			.filter(Boolean)
			.join(' · ');
	}
	const canDry = (u: AmsUnit) =>
		!!dryingRange(u.model) &&
		printer.caps?.amsDrying !== false &&
		s?.firmwareSupport.remoteDrying !== false;
	function dryText(u: AmsUnit) {
		if (u.drying) {
			const h = Math.floor(u.drying.remainingMinutes / 60);
			const m = u.drying.remainingMinutes % 60;
			const status =
				u.dryStatus !== null && u.dryStatus !== 2
					? `${DRY_STATUS[u.dryStatus] ?? 'Drying'} · `
					: '';
			return `${status}Drying${u.drying.temp ? ` at ${u.drying.temp} °C` : ''}, ${h ? `${h} h ` : ''}${m} min left`;
		}
		return u.dryStatus ? (DRY_STATUS[u.dryStatus] ?? '') : '';
	}
	async function stopDrying(u: AmsUnit) {
		busy = true;
		await lab.call(
			'POST',
			`/api/printers/${id}/ams/drying`,
			{ action: 'stop', amsId: u.id },
			'Drying stopped.'
		);
		busy = false;
	}

	const taken = $derived(
		new Set(Object.values(amsLinks.states).flatMap((x) => x.links.map((l) => l.spoolId)))
	);
	/** The short shelf line under a tray. */
	function shelfLine(t: PrinterTray): { text: string; tone: 'ok' | 'new' | 'ask' | '' } {
		if (!t.type) return { text: '', tone: '' };
		const link = amsState?.links.find((l) => l.tray === t.global);
		const others = new Set([...taken].filter((sid) => sid !== link?.spoolId));
		const m = matchTray(t, spools, { linkedSpoolId: link?.spoolId, taken: others });
		if (m.kind === 'linked' || m.kind === 'rfid') {
			const sp = spools.find((x) => x.id === m.spoolId);
			return { text: sp?.colorName || 'On the shelf', tone: 'ok' };
		}
		if (m.kind === 'suggest') return { text: 'Link?', tone: 'ask' };
		return { text: 'Not on the shelf', tone: 'new' };
	}
	const openPrinter = $derived(open !== null ? printer : null);
</script>

{#snippet tray(t: PrinterTray)}
	{@const line = shelfLine(t)}
	<button
		type="button"
		class="ams-slot tray-button"
		class:active={t.active}
		class:vacant={!t.type}
		data-tray={t.global}
		aria-label="{trayLabel(t.global, dual)}: {t.type || 'empty'}"
		onclick={() => (open = t.global)}
	>
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
		{#if line.text}<small class="shelf-line {line.tone}">{line.text}</small>{/if}
	</button>
{/snippet}

<section class="panel" data-panel="ams">
	<div class="panel-head">
		<h2>Filament</h2>
		{#if s?.ams.length}
			<div class="head-actions">
				<button
					class="mini"
					disabled={!online}
					title={online ? undefined : 'The printer is offline.'}
					onclick={() => (options = true)}>AMS options</button
				>
			</div>
		{/if}
	</div>
	{#each s?.ams ?? [] as unit (unit.id)}
		<div class="ams-unit" data-ams={unit.id}>
			<header>
				<span>{unitName(unit)}</span>{#if climate(unit)}<small>{climate(unit)}</small>{/if}
			</header>
			{#if canDry(unit) || unit.drying}
				<div class="dry-row">
					<span>{dryText(unit) || 'Not drying'}</span>
					{#if unit.drying}
						<button class="mini" disabled={busy || !online} onclick={() => stopDrying(unit)}
							>Stop drying</button
						>
					{:else if canDry(unit)}
						<button
							class="mini"
							disabled={!online}
							title={online ? undefined : 'The printer is offline.'}
							onclick={() => (drying = unit)}>Dry…</button
						>
					{/if}
				</div>
			{/if}
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

{#if openPrinter && open !== null}
	<TrayDialog printer={openPrinter} global={open} onclose={() => (open = null)} />
{/if}
{#if drying}
	<DryingDialog
		printerId={id}
		unit={drying}
		name={unitName(drying)}
		onclose={() => (drying = null)}
	/>
{/if}
{#if options}
	<OptionsDialog
		printerId={id}
		options={amsState?.options ?? null}
		onclose={() => (options = false)}
	/>
{/if}

<style>
	.tray-button {
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
		width: 100%;
		min-width: 0;
	}
	.tray-button:hover {
		border-color: var(--line-strong);
	}
	.tray-button strong {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.shelf-line {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.shelf-line.ok {
		color: var(--lime) !important;
	}
	.shelf-line.ask {
		color: var(--cyan) !important;
	}
	.shelf-line.new {
		color: var(--amber) !important;
	}
	.dry-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: -2px 0 8px;
		font-size: 12px;
		color: var(--muted);
	}
</style>
