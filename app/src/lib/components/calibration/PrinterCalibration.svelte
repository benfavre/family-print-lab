<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import type { FlowRatioResult, KProfile, PrinterCalibInfo } from '$lib/shared/slicer-calibration';

	// The printer's own calibration, as Bambu Studio's device tab offers it: the flow dynamics (K-value)
	// profiles it keeps per filament and nozzle, picking one for a tray, and its automatic flow dynamics
	// and flow rate calibration with their results.
	let { printerId }: { printerId: string } = $props();
	const { lab } = useApp();

	let info = $state<PrinterCalibInfo | null>(null);
	let profiles = $state<KProfile[] | null>(null);
	let paResults = $state<KProfile[] | null>(null);
	let flowResults = $state<FlowRatioResult[] | null>(null);
	let error = $state('');
	let busy = $state(false);
	let trays = $state<number[]>([]);
	let draft = $state({ name: '', kValue: 0.02, filamentId: '' });

	const base = $derived(`/api/printers/${encodeURIComponent(printerId)}/calibration`);
	const printer = $derived(lab.printerById(printerId));
	const online = $derived(!!printer?.connected);
	const printing = $derived(!!printer?.printing);
	const trayName = (global: number | undefined) =>
		info?.trays.find((t) => t.global === global)?.label ??
		(global === undefined ? '' : `Tray ${global}`);

	$effect(() => {
		void printerId;
		info = null;
		profiles = null;
		fetch(base)
			.then(async (r) => {
				const data = await r.json().catch(() => ({}));
				if (!r.ok) throw new Error(data.error ?? `Could not load (${r.status}).`);
				info = data;
				error = '';
			})
			.catch((e) => (error = (e as Error).message));
	});

	/** Asks the printer (a request that waits for its answer); toasts and returns null on error. */
	async function ask<T>(method: string, path: string, body?: unknown, success?: string) {
		busy = true;
		try {
			return await lab.call<T>(method, `${base}${path}`, body, success);
		} finally {
			busy = false;
		}
	}

	async function loadProfiles() {
		const list = await ask<KProfile[]>('GET', '/k-profiles');
		if (list) profiles = list as unknown as KProfile[];
	}
	async function saveProfile(e: SubmitEvent) {
		e.preventDefault();
		const list = await ask<KProfile[]>(
			'POST',
			'/k-profiles',
			{ ...draft, nozzleVolume: info?.nozzleVolume ?? 'standard' },
			'Profile saved on the printer.'
		);
		if (list) {
			profiles = list as unknown as KProfile[];
			draft = { name: '', kValue: 0.02, filamentId: draft.filamentId };
		}
	}
	async function useFor(k: KProfile, tray: number) {
		await ask(
			'PUT',
			'/k-profiles',
			{ tray, caliIdx: k.caliIdx, filamentId: k.filamentId },
			`${trayName(tray)} uses “${k.name}”.`
		);
	}
	async function remove(k: KProfile) {
		const list = await ask<KProfile[]>(
			'DELETE',
			'/k-profiles',
			{
				caliIdx: k.caliIdx,
				filamentId: k.filamentId,
				extruderId: k.extruderId,
				nozzleVolume: info?.nozzleVolume ?? 'standard'
			},
			'Profile deleted.'
		);
		if (list) profiles = list as unknown as KProfile[];
	}
	async function start(kind: 'pa' | 'flow') {
		const ok = await ask(
			'POST',
			'/start',
			{ kind, trays },
			'Calibration sent. Get the results when the printer has finished.'
		);
		if (!ok) return;
		if (kind === 'pa') paResults = null;
		else flowResults = null;
	}
	async function results(kind: 'pa' | 'flow') {
		const r = await ask<{ pa?: KProfile[]; flow?: FlowRatioResult[] }>(
			'GET',
			`/results?kind=${kind}`
		);
		if (r?.pa) paResults = r.pa;
		if (r?.flow) flowResults = r.flow;
	}
	async function keep(k: KProfile) {
		const list = await ask<KProfile[]>(
			'POST',
			'/k-profiles',
			{
				name: trayName(k.trayId) || k.filamentId,
				kValue: k.kValue,
				filamentId: k.filamentId,
				settingId: k.settingId,
				tray: k.trayId ?? null,
				nozzleVolume: info?.nozzleVolume ?? 'standard'
			},
			'Result saved as a profile.'
		);
		if (list) profiles = list as unknown as KProfile[];
	}
</script>

{#if error}
	<p class="error-text" role="alert">{error}</p>
{:else if !info}
	<p class="panel-empty">Loading…</p>
{:else}
	<section class="panel">
		<div class="panel-head">
			<h2>Flow dynamics profiles</h2>
			{#if !info.pa}
				<button class="mini" onclick={loadProfiles} disabled={busy || !online}
					>{profiles ? 'Reload' : 'Load from the printer'}</button
				>
			{/if}
		</div>
		{#if info.pa}
			<p class="panel-empty">{info.pa} Use the pressure advance tests on the Calibration page.</p>
		{:else}
			<p class="hint">
				The pressure advance (K) values the printer keeps for each filament on its {info.nozzleDiameter}
				mm nozzle.
			</p>
			{#if !online}<p class="hint">The printer is offline.</p>{/if}
			{#if profiles}
				{#if profiles.length}
					<table>
						<thead><tr><th>Name</th><th>K</th><th>Filament</th><th>Use for</th><th></th></tr></thead
						>
						<tbody>
							{#each profiles as k (`${k.filamentId}:${k.caliIdx}`)}
								<tr>
									<td>{k.name}</td>
									<td class="num">{k.kValue.toFixed(3)}</td>
									<td>{k.filamentId}</td>
									<td>
										<select
											aria-label="Use {k.name} for a tray"
											disabled={busy || printing}
											onchange={(e) => {
												const v = e.currentTarget.value;
												e.currentTarget.value = '';
												if (v) void useFor(k, Number(v));
											}}
										>
											<option value="">Pick a tray…</option>
											{#each info.trays.filter((t) => t.filamentId === k.filamentId) as t (t.global)}
												<option value={t.global}>{t.label}</option>
											{/each}
										</select>
									</td>
									<td
										><button
											class="mini"
											onclick={() => remove(k)}
											disabled={busy || printing}
											aria-label="Delete {k.name}">Delete</button
										></td
									>
								</tr>
							{/each}
						</tbody>
					</table>
				{:else}
					<p class="panel-empty">No profiles saved on the printer yet.</p>
				{/if}
				<form onsubmit={saveProfile} class="add">
					<label class="field">Name<input bind:value={draft.name} maxlength="40" required /></label>
					<label class="field"
						>K value<input
							type="number"
							step="0.001"
							min="0"
							max="10"
							bind:value={draft.kValue}
							required
						/></label
					>
					<label class="field"
						>Filament<select bind:value={draft.filamentId} required>
							<option value="" disabled>Pick…</option>
							{#each [...new Set(info.trays.map((t) => t.filamentId).filter(Boolean))] as id (id)}
								<option value={id}
									>{info.trays.find((t) => t.filamentId === id)?.type} ({id})</option
								>
							{/each}
						</select></label
					>
					<button class="mini primary-mini" type="submit" disabled={busy || printing}
						>Add a profile</button
					>
				</form>
			{/if}
		{/if}
	</section>

	<section class="panel">
		<h2 class="panel-title">Automatic calibration on the printer</h2>
		{#if info.pa && info.flow}
			<p class="panel-empty">{info.pa}</p>
		{:else}
			<p class="hint">
				The printer prints and measures its own test lines, then keeps the result. Pick the trays to
				calibrate.
			</p>
			<div class="trays">
				{#each info.trays as t (t.global)}
					<label class="tray" title={t.filamentId ? '' : 'Set this tray’s filament first'}>
						<input type="checkbox" value={t.global} bind:group={trays} disabled={!t.filamentId} />
						{#if t.color}<i class="dot" style:background={t.color} aria-hidden="true"></i>{/if}
						{t.label} · {t.type}{t.k !== null ? ` · K ${t.k}` : ''}
					</label>
				{:else}
					<p class="panel-empty">No filament loaded.</p>
				{/each}
			</div>
			<div class="row">
				{#if !info.pa}
					<button
						class="mini primary-mini"
						onclick={() => start('pa')}
						disabled={busy || !online || printing || !trays.length}>Flow dynamics</button
					>
					<button class="mini" onclick={() => results('pa')} disabled={busy || !online}
						>Get the results</button
					>
				{/if}
				{#if !info.flow}
					<button
						class="mini primary-mini"
						onclick={() => start('flow')}
						disabled={busy || !online || printing || !trays.length}>Flow rate</button
					>
					<button class="mini" onclick={() => results('flow')} disabled={busy || !online}
						>Get the results</button
					>
				{/if}
			</div>
			{#if paResults}
				<h3>Flow dynamics results</h3>
				{#if paResults.length}
					<ul class="results">
						{#each paResults as k, i (i)}
							<li>
								{trayName(k.trayId)}: K <b>{k.kValue.toFixed(3)}</b>{k.confidence === 1
									? ' (uncertain)'
									: k.confidence === 2
										? ' (failed)'
										: ''}
								<button class="mini" onclick={() => keep(k)} disabled={busy || k.confidence === 2}
									>Save as a profile</button
								>
							</li>
						{/each}
					</ul>
				{:else}<p class="panel-empty">No results yet.</p>{/if}
			{/if}
			{#if flowResults}
				<h3>Flow rate results</h3>
				{#if flowResults.length}
					<ul class="results">
						{#each flowResults as f, i (i)}
							<li>
								{trayName(f.trayId)}: flow ratio <b>{f.flowRatio.toFixed(3)}</b>{f.confidence
									? ' (uncertain)'
									: ''}. Enter it on the Calibration page, or in the spool’s filament preset.
							</li>
						{/each}
					</ul>
				{:else}<p class="panel-empty">No results yet.</p>{/if}
			{/if}
		{/if}
	</section>
{/if}

<style>
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
		margin-bottom: 12px;
	}
	th {
		text-align: left;
		font-weight: 500;
		color: var(--muted);
		font-size: 12px;
		padding: 4px 6px;
		border-bottom: 1px solid var(--line);
	}
	td {
		padding: 5px 6px;
		border-bottom: 1px solid var(--line);
	}
	td select {
		font-size: 12.5px;
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.add {
		display: grid;
		grid-template-columns: 2fr 1fr 2fr auto;
		gap: 8px;
		align-items: end;
	}
	.add button {
		margin-bottom: 12px;
	}
	.hint {
		color: var(--dim);
		font-size: 12px;
		margin: 0 0 8px;
	}
	.trays {
		display: grid;
		gap: 4px;
		margin-bottom: 10px;
		font-size: 13px;
	}
	.tray {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.dot {
		display: inline-block;
		width: 9px;
		height: 9px;
		border-radius: 50%;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	h3 {
		font-size: 13px;
		margin: 12px 0 6px;
	}
	.results {
		margin: 0;
		padding-left: 18px;
		font-size: 13px;
		display: grid;
		gap: 6px;
	}
	.error-text {
		color: var(--err-text);
		font-size: 13px;
	}
	@media (max-width: 640px) {
		.add {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
