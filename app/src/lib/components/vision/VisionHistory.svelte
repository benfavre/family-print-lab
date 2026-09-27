<script lang="ts">
	import { stamp } from '$lib/client/format';
	import { VERDICT_LABEL, verdictText, type VisionCheck } from '$lib/shared/vision';
	import { verdictTone, type VisionData } from './vision.svelte';

	// Every check of this printer, newest first, with its picture while it is kept (14 days).
	let { data }: { data: VisionData } = $props();
	const PAGE = 30;
	let checks = $state<VisionCheck[]>([]);
	let more = $state(false);
	let error = $state('');
	let loading = $state(false);
	let only = $state<'all' | 'problems'>('all');
	let open = $state<VisionCheck | null>(null);

	async function load(before?: string) {
		loading = true;
		const filter = only;
		try {
			const q = `limit=${PAGE}${filter === 'problems' ? '&problems=1' : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
			const res = await fetch(`${data.base}/checks?${q}`);
			const body = await res.json().catch(() => ({}));
			if (filter !== only) return;
			if (!res.ok) {
				error = body.error ?? `Could not load the checks (${res.status}).`;
				return;
			}
			error = '';
			const page = body.checks as VisionCheck[];
			checks = before ? [...checks, ...page] : page;
			more = page.length === PAGE;
		} catch {
			error = 'Could not reach the app server. Is it still running?';
		} finally {
			loading = false;
		}
	}

	// Reload from the top whenever a check finishes (data.version) or the filter changes.
	$effect(() => {
		void data.version;
		void data.base;
		void only;
		void load();
	});
</script>

<!-- Escape closes the picture wherever the focus is. -->
<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = null)} />

<section class="panel">
	<header class="panel-head">
		<h2>Checks</h2>
		<div class="filters" role="group" aria-label="Show">
			<button class="chip" class:active={only === 'all'} onclick={() => (only = 'all')}>All</button>
			<button class="chip" class:active={only === 'problems'} onclick={() => (only = 'problems')}
				>Problems</button
			>
		</div>
	</header>
	{#if error}
		<p class="error">{error}</p>
	{:else if !checks.length && !loading}
		<p class="panel-empty">
			{only === 'all'
				? 'No checks yet. They show up here once a print is checked, or when you press Check now.'
				: 'No problems spotted.'}
		</p>
	{:else}
		<ul class="checks">
			{#each checks as c (c.id)}
				<li style:--tone={verdictTone(c.verdict, c.error)}>
					{#if c.hasFrame}
						<button class="thumb" onclick={() => (open = c)} aria-label="Show the picture"
							><img src={data.frameUrl(c)} alt="" loading="lazy" /></button
						>
					{:else}
						<span class="thumb none">No picture</span>
					{/if}
					<div class="text">
						<b>{verdictText(c)}</b>
						<small
							>{stamp(c.at)}{c.task ? ` · ${c.task}` : ''}{c.layer !== null
								? ` · layer ${c.layer}${c.totalLayers ? `/${c.totalLayers}` : ''}`
								: ''} · {c.provider === 'local' ? 'rough check' : 'AI'}</small
						>
						<p>{c.error ?? c.reason}</p>
						{#if c.paused}<p class="flag">Paused the print.</p>
						{:else if c.alerted}<p class="flag">Sent an alert.</p>{/if}
					</div>
				</li>
			{/each}
		</ul>
		{#if more}
			<button class="mini" disabled={loading} onclick={() => load(checks.at(-1)?.at)}
				>{loading ? 'Loading…' : 'Older checks'}</button
			>
		{/if}
	{/if}
</section>

{#if open}
	<div
		class="viewer"
		role="dialog"
		aria-modal="true"
		aria-label="Picture of the check"
		tabindex="-1"
		onclick={() => (open = null)}
		onkeydown={(e) => e.key === 'Escape' && (open = null)}
	>
		<figure>
			<img src={data.frameUrl(open)} alt="What the check saw" />
			<figcaption>
				<b>{open.error ? 'Could not check' : VERDICT_LABEL[open.verdict]}</b> · {stamp(open.at)} · {open.error ??
					open.reason}
			</figcaption>
		</figure>
	</div>
{/if}

<style>
	.filters {
		display: flex;
		gap: 6px;
	}
	.chip.active {
		border-color: var(--cyan);
		color: var(--text);
	}
	.checks {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.checks li {
		display: flex;
		gap: 12px;
		padding: 8px;
		border: 1px solid var(--line);
		border-left: 3px solid var(--tone);
		border-radius: var(--r-md);
		font-size: 13px;
	}
	.thumb {
		flex: 0 0 128px;
		aspect-ratio: 16 / 9;
		padding: 0;
		border: 0;
		border-radius: var(--r-sm);
		overflow: hidden;
		background: var(--panel-strong);
		cursor: zoom-in;
	}
	.thumb img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.thumb.none {
		display: grid;
		place-items: center;
		color: var(--dim);
		font-size: 12px;
		cursor: default;
	}
	.text {
		display: grid;
		gap: 2px;
		align-content: start;
		min-width: 0;
	}
	.text b {
		color: var(--tone);
	}
	.text small {
		color: var(--dim);
		overflow-wrap: anywhere;
	}
	.text p {
		margin: 2px 0 0;
		color: var(--text-2);
	}
	.text .flag {
		color: var(--amber);
	}
	.viewer {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgb(var(--lo) / 0.75);
		cursor: zoom-out;
	}
	.viewer figure {
		margin: 0;
		max-width: min(960px, 100%);
	}
	.viewer img {
		display: block;
		width: 100%;
		border-radius: var(--r-md);
	}
	.viewer figcaption {
		margin-top: 8px;
		font-size: 13px;
		color: var(--text-2);
	}
	@media (max-width: 520px) {
		.thumb {
			flex-basis: 96px;
		}
	}
</style>
