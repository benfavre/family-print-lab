<script lang="ts">
	import {
		ACCESSORY_DIAMETERS,
		ACCESSORY_NOZZLE_TYPES,
		NOZZLE_DIAMETERS,
		isAccessoryNozzleType,
		nozzleTypeLabel,
		type AccessoryNozzleType
	} from '$lib/shared/maintenance';
	import type { PrinterStatus } from '$lib/shared/domain';
	import type { MaintenanceData } from './overview.svelte';

	// The nozzles the printer reports (type, diameter, wear), the H2C hotend rack, and logging a nozzle
	// change (on single-nozzle printers it can also tell the printer, system.set_accessories).
	let { printer, data }: { printer: PrinterStatus; data: MaintenanceData } = $props();
	const nozzles = $derived(printer.state?.nozzles ?? []);
	const rack = $derived(data.overview?.rack ?? null);
	const canSet = $derived(!!data.overview?.canSetNozzle);
	const busy = $derived(!!printer.printing);
	const online = $derived(!!printer.connected);

	let open = $state(false);
	let diameter = $state<number>(0.4);
	let type = $state<AccessoryNozzleType | ''>('');
	let note = $state('');
	let send = $state(true);
	let saving = $state(false);
	// The printer is told only type and size pairs Bambu Studio offered (ACCESSORY_DIAMETERS).
	const pairOk = $derived(!!type && ACCESSORY_DIAMETERS[type].includes(diameter));
	const canSend = $derived(canSet && online && !busy && pairOk);
	const sending = $derived(canSend && send);

	function start() {
		const first = nozzles[0];
		diameter = (NOZZLE_DIAMETERS as readonly number[]).includes(first?.diameter ?? 0)
			? first!.diameter!
			: 0.4;
		type = isAccessoryNozzleType(first?.type) ? first.type : '';
		note = '';
		send = true;
		open = true;
	}
	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (saving) return;
		saving = true;
		try {
			const ok = await data.write(
				'POST',
				'/nozzle',
				{ diameter, type: type || null, note, send: sending },
				sending ? 'Nozzle change logged and sent to the printer.' : 'Nozzle change logged.'
			);
			if (ok) open = false;
		} finally {
			saving = false;
		}
	}
	const side = (id: number) => (nozzles.length > 1 ? (id === 0 ? 'Right' : 'Left') : 'Nozzle');
</script>

<section class="panel">
	<h2 class="panel-title">Nozzles</h2>
	{#if nozzles.length}
		<ul class="nozzles">
			{#each nozzles as n (n.id)}
				<li>
					<b>{side(n.id)}</b>
					<span>{n.diameter ? `${n.diameter} mm` : '—'} · {nozzleTypeLabel(n.type)}</span>
					{#if n.wear !== null}<small>Wear reported: {n.wear}</small>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="panel-empty">The printer has not reported its nozzles yet.</p>
	{/if}
	{#if rack}
		<h3>Hotend rack</h3>
		{#if rack.status || rack.position}
			<p class="hint">{[rack.status, rack.position].filter(Boolean).join(' · ')}</p>
		{/if}
		{#if rack.nozzles.length}
			<ul class="nozzles">
				{#each rack.nozzles as n (n.slot)}
					<li>
						<b>Position {n.slot + 1}</b>
						<span
							>{#if n.color}<i class="dot" style:background={n.color} aria-hidden="true"
								></i>{/if}{n.diameter ? `${n.diameter} mm` : '—'} · {nozzleTypeLabel(n.type)}</span
						>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="panel-empty">No hotends on the rack.</p>
		{/if}
	{/if}
	{#if open}
		<form onsubmit={save}>
			<div class="fields-row">
				<label class="field"
					>Diameter<select bind:value={diameter}>
						{#each NOZZLE_DIAMETERS as d (d)}<option value={d}>{d} mm</option>{/each}
					</select></label
				>
				<label class="field"
					>Type<select bind:value={type}>
						<option value="">Not sure</option>
						{#each ACCESSORY_NOZZLE_TYPES as t (t)}<option value={t}>{nozzleTypeLabel(t)}</option
							>{/each}
					</select></label
				>
			</div>
			<label class="field">Note<input bind:value={note} maxlength="500" /></label>
			{#if canSet}
				<label class="toggle"
					><input
						type="checkbox"
						checked={sending}
						disabled={!canSend}
						onchange={(e) => (send = e.currentTarget.checked)}
					/> Tell the printer too</label
				>
				{#if !online}
					<p class="hint">The printer is offline, so this only goes in the log.</p>
				{:else if busy}
					<p class="hint">You can tell the printer once the print is over.</p>
				{:else if !type}
					<p class="hint">Choose the type to tell the printer.</p>
				{:else if !pairOk}
					<p class="hint">
						{nozzleTypeLabel(type)} nozzles come in {ACCESSORY_DIAMETERS[type].join(', ')} mm, so this
						only goes in the log.
					</p>
				{/if}
			{/if}
			<div class="row">
				<button class="mini primary-mini" type="submit" disabled={saving}>Log the change</button>
				<button class="mini" type="button" onclick={() => (open = false)}>Cancel</button>
			</div>
		</form>
	{:else}
		<button class="mini" onclick={start}>Log a nozzle change</button>
	{/if}
</section>

<style>
	h3 {
		font-size: 13px;
		margin: 12px 0 6px;
	}
	.nozzles {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		display: grid;
		gap: 4px;
		font-size: 13px;
	}
	.nozzles li {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: 10px;
		padding: 6px 0;
		border-bottom: 1px solid var(--line);
	}
	.nozzles small {
		grid-column: 2;
		color: var(--dim);
		font-size: 12px;
	}
	.dot {
		display: inline-block;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		margin-right: 6px;
		vertical-align: baseline;
	}
	.hint {
		color: var(--dim);
		font-size: 12px;
		margin: 0 0 8px;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		margin-bottom: 10px;
	}
	.row {
		display: flex;
		gap: 6px;
	}
</style>
