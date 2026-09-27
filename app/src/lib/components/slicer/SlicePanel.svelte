<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { download } from '$lib/client/actions';
	import { duration, weight } from '$lib/client/format';
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { outsidePlate } from '$lib/client/slicer/edit';
	import { filamentRows, objectRows, totalGrams } from '$lib/client/slicer/results';
	import { slicedUrl } from '$lib/client/slicer/api';
	import { PRINTER_MODELS, type ModelCode } from '$lib/shared/printers/models';

	// Slice the active plate (with progress and a Stop button), what it gave, and sending it on.
	let { ws, snapshot }: { ws: WorkspaceState; snapshot: (plate: number) => string | null } =
		$props();
	const { lab } = useApp();
	const plate = $derived(ws.project.plates.find((p) => p.index === ws.plate));
	const empty = $derived(!plate?.instances.length);
	const outside = $derived.by(() => {
		void ws.meshVersion;
		return outsidePlate(ws.project, ws.bed, ws.meshSource).filter((m) =>
			m.endsWith(`plate ${ws.plate}.`)
		);
	});
	const found = $derived(ws.plateResult());
	const result = $derived(found?.result ?? null);
	const canSlice = $derived(ws.can('slice') && ws.can('export.gcode3mf'));
	const slicing = $derived(!!ws.sliceTask);
	const printerModel = $derived.by(() => {
		const code = result?.printerModelId as ModelCode | undefined;
		return code && PRINTER_MODELS[code] ? PRINTER_MODELS[code].short : null;
	});
	const target = $derived(lab.printerById(ws.printerId));
	const mismatch = $derived(
		!!result && !!target?.model && !!result.printerModelId && target.model !== result.printerModelId
	);
	/** Each warning once (the command line repeats them per copy of an object). */
	const warnings = $derived([...new Set(result?.stats.warnings.map((w) => w.message) ?? [])]);
	let sending = $state(false);

	async function send(queue: boolean) {
		sending = true;
		await ws.send(queue);
		sending = false;
	}
</script>

<section class="panel slp" aria-label="Slice and send">
	<div class="slp-head">
		<h2 class="panel-title">Slice and send</h2>
		{#if ws.backend?.engine}
			<span class="backend"
				>{ws.backend.engine === 'printlab-slicer'
					? 'Print Lab Slicer'
					: 'Bambu Studio command line'}</span
			>
		{/if}
	</div>

	{#if !ws.backend?.engine}
		<p class="hint">
			No slicer is installed. See Integrations to add one; you can still edit and save the project.
		</p>
	{:else if slicing}
		<div class="progress" role="status" aria-live="polite">
			<div class="bar"><span style:width="{Math.max(3, ws.progress?.percent ?? 0)}%"></span></div>
			<span class="msg">{ws.progress?.message ?? 'Slicing…'}</span>
			<button class="mini" onclick={() => ws.cancelSlice()}>Stop</button>
		</div>
	{:else}
		{#each outside as m (m)}<p class="hint warn">{m}</p>{/each}
		<button
			class="primary"
			disabled={!canSlice || empty || ws.doc.saving}
			title={empty ? 'Put something on this plate first' : ''}
			onclick={() => ws.slice(snapshot(ws.plate))}
			>{result && !found?.stale ? 'Slice again' : `Slice plate ${ws.plate}`}</button
		>
	{/if}

	{#if result}
		<div class="result" class:stale={found?.stale}>
			{#if found?.stale}<p class="hint">
					The project changed since this was sliced. Slice again before sending.
				</p>{/if}
			<div class="figures">
				<span><b>{duration(Math.max(1, Math.round(result.stats.seconds / 60)))}</b> print time</span
				>
				<span><b>{weight(totalGrams(result))}</b> filament</span>
				<span><b>{result.stats.layers || result.sliced.layers}</b> layers</span>
			</div>
			{#if filamentRows(ws.project, result).length}
				<ul class="fils">
					{#each filamentRows(ws.project, result) as f (f.index)}
						<li>
							<i style:--c={f.color.slice(0, 7)}></i>{f.index} · {f.type} · {weight(f.grams)} · {f.meters}
							m
						</li>
					{/each}
				</ul>
			{/if}
			{#if warnings.length}
				<ul class="warnings">
					{#each warnings as w (w)}<li>{w}</li>{/each}
				</ul>
			{/if}
			{#if objectRows(ws.project, result).length}
				<table class="breakdown">
					<caption class="sr-only">Time and filament per object</caption>
					<thead
						><tr
							><th scope="col">Object</th><th scope="col">Time</th><th scope="col">Filament</th></tr
						></thead
					>
					<tbody>
						{#each objectRows(ws.project, result) as row (row.objectId)}
							<tr>
								<th scope="row">{row.name}</th>
								<td
									>{row.seconds === null
										? '—'
										: duration(Math.max(1, Math.round(row.seconds / 60)))}</td
								>
								<td>{row.grams === null ? '—' : weight(row.grams)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else if result.backend !== 'printlab-slicer'}
				<p class="hint">Time per object needs Print Lab Slicer.</p>
			{/if}
			{#if !found?.stale}
				<div class="send">
					{#if printerModel}<span class="hint">Sliced for the {printerModel}.</span>{/if}
					{#if mismatch}<p class="hint warn">
							The chosen printer is a different model. Pick its presets and slice again.
						</p>{/if}
					<div class="buttons">
						{#if ws.backend?.queue}
							<button class="secondary" disabled={sending} onclick={() => send(true)}
								>Add to queue</button
							>
						{/if}
						<button
							class="primary"
							disabled={sending || !lab.printerList.length}
							onclick={() => send(false)}>Send to printer…</button
						>
						<button class="mini" onclick={() => download(slicedUrl(ws.id, ws.plate))}
							>Printer file</button
						>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.slp {
		display: grid;
		gap: 10px;
	}
	.slp-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 8px;
	}
	.backend {
		font-size: 11.5px;
		color: var(--muted);
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.warn {
		color: var(--err-text);
	}
	.progress {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 6px 10px;
		align-items: center;
	}
	.bar {
		grid-column: 1 / -1;
		height: 6px;
		border-radius: 99px;
		background: var(--line);
		overflow: hidden;
	}
	.bar span {
		display: block;
		height: 100%;
		background: var(--cyan);
		transition: width 0.3s;
	}
	.msg {
		font-size: 12.5px;
		color: var(--muted);
	}
	.result {
		display: grid;
		gap: 8px;
	}
	.result.stale .figures {
		opacity: 0.55;
	}
	.figures {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		font-size: 12.5px;
		color: var(--muted);
	}
	.figures b {
		color: var(--text);
	}
	.fils,
	.warnings {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 3px;
		font-size: 12px;
	}
	.warnings li {
		color: var(--amber);
	}
	.fils i {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 3px;
		margin-right: 6px;
		background: var(--c);
	}
	.breakdown {
		width: 100%;
		font-size: 12px;
		border-collapse: collapse;
	}
	.breakdown th,
	.breakdown td {
		padding: 3px 4px;
		text-align: left;
		border-bottom: 1px solid var(--line);
		font-weight: normal;
	}
	.breakdown thead th {
		color: var(--muted);
	}
	.send {
		display: grid;
		gap: 6px;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}
</style>
