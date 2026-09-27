<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { UI } from '$lib/client/registry';
	import { weight } from '$lib/client/format';
	import Modal from '../Modal.svelte';
	import { amsLinks } from './links.svelte';
	import {
		FILAMENT_PRESETS,
		matchTray,
		presetFor,
		remainDisagreement,
		type AmsSpool,
		type AmsState
	} from '$lib/shared/ams';
	import { trayLabel } from '$lib/shared/printing';
	import { EXT_DEPUTY, EXT_MAIN, type PrinterTray } from '$lib/shared/printers/status';
	import type { PrinterStatus } from '$lib/shared/domain';

	// One tray up close: the spool it holds on the shelf (or a suggestion, or "Add to Filament"),
	// the printer's own settings for it, an RFID re-read, and every registered tray action.
	let {
		printer,
		global,
		onclose
	}: { printer: PrinterStatus; global: number; onclose: () => void } = $props();
	const app = useApp();
	const { lab } = app;
	const id = $derived(printer.id!);
	const dual = $derived((printer.state?.nozzles.length ?? 1) > 1);
	const tray = $derived(
		[
			...(printer.state?.ams ?? []).flatMap((u) => u.trays),
			...(printer.state?.externalSpools ?? [])
		].find((t) => t.global === global)
	);
	const external = $derived(global === EXT_MAIN || global === EXT_DEPUTY);
	const spools = $derived(lab.ws.spools as AmsSpool[]);
	const link = $derived(amsLinks.link(id, global));
	const taken = $derived(
		new Set(
			Object.values(amsLinks.states)
				.flatMap((s) => s.links)
				.filter((l) => !(l.printerId === id && l.tray === global))
				.map((l) => l.spoolId)
		)
	);
	const match = $derived(
		tray
			? matchTray(tray, spools, { linkedSpoolId: link?.spoolId, taken })
			: { kind: 'none' as const }
	);
	const linked = $derived(
		match.kind === 'linked' || match.kind === 'rfid'
			? spools.find((s) => s.id === match.spoolId)
			: undefined
	);
	const differ = $derived(linked && tray ? remainDisagreement(tray, linked) : null);
	const spoolName = (s: AmsSpool) =>
		[s.colorName || s.colorHex, s.brand, s.material].filter(Boolean).join(' · ');
	const actions = $derived(
		tray
			? UI.trayActions.filter((a) => !a.id.startsWith('ams-') && (a.show?.(tray, printer) ?? true))
			: []
	);
	const locked = $derived(!!tray?.tagUid);
	const canReadTag = $derived(!external && printer.caps?.amsReadRfid !== false);
	const online = $derived(!!printer.connected);
	const offline = $derived(online ? undefined : 'The printer is offline.');

	let busy = $state(false);
	let picking = $state(false);
	let pick = $state('');
	let editing = $state(false);
	let f = $state({
		material: FILAMENT_PRESETS[0].material,
		colorHex: '#ffffff',
		tempMin: FILAMENT_PRESETS[0].tempMin,
		tempMax: FILAMENT_PRESETS[0].tempMax
	});

	async function post(path: string, body: unknown, success?: string) {
		busy = true;
		const r = await lab.call<AmsState>('POST', `/api/printers/${id}/ams/${path}`, body, success);
		busy = false;
		amsLinks.adopt(r);
		return r;
	}
	const addToShelf = () => post('add', { tray: global }, 'Added to the Filament shelf.');
	const linkTo = (spoolId: string) => post('links', { tray: global, spoolId }, 'Linked.');
	async function unlink() {
		busy = true;
		const r = await lab.call<AmsState>(
			'DELETE',
			`/api/printers/${id}/ams/links?tray=${global}`,
			undefined,
			'Unlinked.'
		);
		busy = false;
		amsLinks.adopt(r);
	}
	/** Starts the settings form from the linked spool, when there is one. */
	function startEditing() {
		const from =
			linked ??
			(match.kind === 'suggest' ? spools.find((s) => s.id === match.spoolIds[0]) : undefined);
		const p = presetFor(from?.material ?? tray?.type ?? 'PLA') ?? FILAMENT_PRESETS[0];
		f = {
			material: p.material,
			colorHex: from?.colorHex ?? (tray?.color ?? '#ffffff').slice(0, 7),
			tempMin: p.tempMin,
			tempMax: p.tempMax
		};
		editing = true;
	}
	function choosePreset() {
		const p = presetFor(f.material);
		if (p) f = { ...f, tempMin: p.tempMin, tempMax: p.tempMax };
	}
	async function saveSettings(e: SubmitEvent) {
		e.preventDefault();
		const r = await post(
			'tray',
			{ tray: global, ...f, tempMin: Number(f.tempMin), tempMax: Number(f.tempMax) },
			'Sent to the printer.'
		);
		if (r) editing = false;
	}
	const label = $derived(trayLabel(global, dual));
</script>

<Modal id="ams-tray" {onclose} {busy}>
	<div class="dialog-top">
		<div>
			<div class="eyebrow">{external ? 'EXTERNAL SPOOL' : `TRAY ${label}`} · {printer.name}</div>
			<h2 id="ams-tray-title">
				{#if tray?.type}{tray.name || tray.type}{:else}Empty{/if}
			</h2>
		</div>
	</div>

	{#if !tray}
		<p class="panel-empty">The printer no longer reports this tray.</p>
	{:else}
		{@const t = tray as PrinterTray}
		<dl class="facts">
			<div>
				<dt>Colour</dt>
				<dd>
					<span class="swatch" style:--swatch={t.color} aria-hidden="true"></span>
					{t.color?.toUpperCase() ?? '—'}
				</dd>
			</div>
			<div>
				<dt>Left</dt>
				<dd>{t.remain !== null ? `${t.remain}% (printer’s estimate)` : 'Not measured'}</dd>
			</div>
			<div>
				<dt>Nozzle</dt>
				<dd>{t.tempMin && t.tempMax ? `${t.tempMin}–${t.tempMax} °C` : '—'}</dd>
			</div>
			<div>
				<dt>Tag</dt>
				<dd>{t.trayUuid || t.tagUid ? 'Bambu RFID spool' : 'No RFID tag'}</dd>
			</div>
		</dl>

		<section class="shelf" aria-label="On the shelf">
			{#if linked}
				<p>
					On the shelf as <a href={resolve('/filament')}>{spoolName(linked)}</a>,
					{weight(linked.remainingGrams)} left.
				</p>
				{#if differ}
					<p class="hint" role="status">
						The printer estimates {weight(differ.printerGrams)} left; the shelf says {weight(
							linked.remainingGrams
						)}.
						<button
							class="mini"
							disabled={busy}
							onclick={() => post('reconcile', { tray: global }, 'Weight updated.')}
							>Use the printer’s figure</button
						>
					</p>
				{/if}
				{#if match.kind === 'linked'}
					<button
						class="mini"
						disabled={busy}
						title={t.trayUuid || t.tagUid
							? 'Not this spool: the spool also forgets this RFID tag.'
							: undefined}
						onclick={unlink}>Unlink</button
					>
				{/if}
			{:else if !t.type}
				<p class="panel-empty">Nothing is loaded here.</p>
			{:else if match.kind === 'new-rfid'}
				<p>A Bambu spool that is not on your shelf yet.</p>
				<button class="mini primary-mini" disabled={busy} onclick={addToShelf}
					>＋ Add to Filament</button
				>
			{:else if match.kind === 'suggest'}
				<p>{match.ambiguous ? 'It could be one of these spools:' : 'It looks like this spool:'}</p>
				<ul class="choices">
					{#each match.spoolIds.slice(0, 4) as sid (sid)}
						{@const s = spools.find((x) => x.id === sid)}
						{#if s}
							<li>
								<span class="swatch" style:--swatch={s.colorHex} aria-hidden="true"></span>
								<span>{spoolName(s)} · {weight(s.remainingGrams)}</span>
								<button class="mini primary-mini" disabled={busy} onclick={() => linkTo(sid)}
									>This one</button
								>
							</li>
						{/if}
					{/each}
				</ul>
				<button class="mini" disabled={busy} onclick={addToShelf}>It is a new spool</button>
			{:else}
				<p>No spool on the shelf matches it.</p>
				<button class="mini primary-mini" disabled={busy} onclick={addToShelf}
					>＋ Add to Filament</button
				>
			{/if}
			{#if t.type && !linked}
				{#if picking}
					<form
						class="pick"
						onsubmit={(e) => {
							e.preventDefault();
							if (pick) void linkTo(pick).then((r) => r && (picking = false));
						}}
					>
						<select bind:value={pick} aria-label="Spool in this tray">
							<option value="">Choose a spool…</option>
							{#each spools.filter((s) => !taken.has(s.id)) as s (s.id)}
								<option value={s.id}>{spoolName(s)}</option>
							{/each}
						</select>
						<button class="mini primary-mini" disabled={!pick || busy}>Link</button>
					</form>
				{:else}
					<button class="mini" onclick={() => (picking = true)}>Link another spool…</button>
				{/if}
			{/if}
		</section>

		{#if editing}
			<form class="settings" onsubmit={saveSettings}>
				<div class="fields-row">
					<label class="field"
						>Material<select bind:value={f.material} onchange={choosePreset}>
							{#each FILAMENT_PRESETS as p (p.material)}<option>{p.material}</option>{/each}
						</select></label
					>
					<label class="field">Colour<input type="color" bind:value={f.colorHex} /></label>
				</div>
				<div class="fields-row">
					<label class="field"
						>Lowest nozzle °C<input
							type="number"
							min="150"
							max="400"
							required
							bind:value={f.tempMin}
						/></label
					>
					<label class="field"
						>Highest nozzle °C<input
							type="number"
							min="150"
							max="400"
							required
							bind:value={f.tempMax}
						/></label
					>
				</div>
				<p class="note">The printer uses these for this tray until another spool goes in.</p>
				<div class="row">
					<button type="button" class="secondary" onclick={() => (editing = false)}>Cancel</button>
					<button class="primary" disabled={busy || !online} title={offline}>Send to printer</button
					>
				</div>
			</form>
		{/if}
	{/if}

	<div class="dialog-actions">
		<div class="tray-actions">
			{#if tray?.type || !external}
				<button
					class="mini"
					disabled={busy || locked || editing || !online}
					title={locked ? 'Bambu spools: the details come from the RFID tag.' : offline}
					onclick={startEditing}>Settings</button
				>
			{/if}
			{#if canReadTag && tray}
				<button
					class="mini"
					disabled={busy || !online}
					title={offline}
					onclick={() => post('rfid', { tray: global }, 'Reading the tag again.')}
					>Read tag again</button
				>
			{/if}
			{#each actions as a (a.id)}
				<button class="mini" onclick={() => tray && a.run({ tray, printer, app })}>{a.label}</button
				>
			{/each}
		</div>
		<button type="button" class="secondary" onclick={onclose}>Close</button>
	</div>
</Modal>

<style>
	.shelf {
		margin: 12px 0;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		display: grid;
		gap: 8px;
		justify-items: start;
		font-size: 13px;
	}
	.shelf p {
		margin: 0;
		color: var(--text-2);
	}
	.hint {
		color: var(--amber) !important;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.choices {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
		width: 100%;
	}
	.choices li {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.choices li span:nth-child(2) {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pick {
		display: flex;
		gap: 6px;
		width: 100%;
	}
	.pick select {
		flex: 1;
		min-width: 0;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		padding: 5px 8px;
		font: inherit;
	}
	.settings {
		margin: 0 0 12px;
	}
	.note {
		font-size: 12px;
		color: var(--dim);
		margin: 4px 0 8px;
	}
	.row {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.tray-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
</style>
