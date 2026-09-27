<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { stamp } from '$lib/client/format';
	import { verdictText } from '$lib/shared/vision';
	import type { PrinterStatus } from '$lib/shared/domain';
	import { scheduleText, VisionData, verdictTone } from './vision.svelte';

	// Printer page side panel: whether AI checks watch this printer, the last result and the latest
	// pictures, with Check now.
	let { printer }: { printer: PrinterStatus } = $props();
	const { lab } = useApp();
	const id = $derived(printer.id ?? '');
	const data = new VisionData(lab, () => id);
	$effect(() => {
		void id;
		return data.watch();
	});
	const o = $derived(data.overview);
	const last = $derived(o?.recent[0] ?? null);
	const frames = $derived((o?.recent ?? []).filter((c) => c.hasFrame).slice(0, 6));
</script>

<section class="panel" data-vision-panel>
	<header class="panel-head">
		<h2>AI check</h2>
		{#if o}<span class="count">{o.active ? 'On' : 'Off'}</span>{/if}
	</header>
	{#if data.error}
		<p class="panel-empty">{data.error}</p>
	{:else if !o}
		<p class="panel-empty">Loading…</p>
	{:else}
		<p class="status">
			{#if o.active}
				{o.methodLabel}, {scheduleText(o.settings)} while printing{o.settings.autoPause
					? '. Pauses the print when sure'
					: ''}.
			{:else if !o.settings.enabled}
				Automatic checks are off. <a href="{resolve('/integrations')}#ai-vision">Switch them on</a> to
				catch spaghetti early.
			{:else}
				Automatic checks are off for this printer.
			{/if}
		</p>
		{#if last}
			<div class="last" style:--tone={verdictTone(last.verdict, last.error)}>
				<b>{verdictText(last)}</b>
				<small>{stamp(last.at)}{last.layer !== null ? ` · layer ${last.layer}` : ''}</small>
				<p>{last.error ?? last.reason}</p>
				{#if last.paused}<p class="paused">The print was paused.</p>{/if}
			</div>
		{/if}
		{#if frames.length}
			<ul class="strip" aria-label="Latest pictures">
				{#each frames as c (c.id)}
					<li style:--tone={verdictTone(c.verdict, c.error)}>
						<a
							href={resolve('/printers/[id]/vision', { id })}
							title="{verdictText(c)} · {stamp(c.at)}"
							><img
								src={data.frameUrl(c)}
								alt="{verdictText(c)}, {stamp(c.at)}"
								loading="lazy"
							/></a
						>
					</li>
				{/each}
			</ul>
		{/if}
		{#if !o.camera}
			<p class="panel-empty">No camera picture from this printer right now.</p>
		{/if}
		<div class="actions">
			<button class="mini" onclick={() => data.checkNow()} disabled={data.running || !o.camera}
				>{data.running ? 'Checking…' : 'Check now'}</button
			>
			{#if o.settings.enabled}
				<label class="option"
					><input
						type="checkbox"
						checked={o.printerOn}
						onchange={(e) => data.setPrinter(e.currentTarget.checked)}
					/> Check this printer</label
				>
			{/if}
		</div>
		<a class="mini" href={resolve('/printers/[id]/vision', { id })}>All checks</a>
	{/if}
</section>

<style>
	.status {
		font-size: 13px;
		color: var(--text-2);
		margin: 0 0 10px;
	}
	.last {
		display: grid;
		gap: 2px;
		padding: 8px 10px;
		margin-bottom: 10px;
		border: 1px solid color-mix(in srgb, var(--tone) 50%, var(--line));
		border-radius: var(--r-md);
		font-size: 13px;
	}
	.last b {
		color: var(--tone);
	}
	.last small {
		color: var(--dim);
	}
	.last p {
		margin: 2px 0 0;
		color: var(--text-2);
	}
	.last .paused {
		color: var(--amber);
	}
	.strip {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
	}
	.strip li {
		border: 2px solid color-mix(in srgb, var(--tone) 60%, transparent);
		border-radius: var(--r-md);
		overflow: hidden;
		aspect-ratio: 16 / 9;
		background: var(--panel-strong);
	}
	.strip a,
	.strip img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
	}
	.option {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
	}
</style>
