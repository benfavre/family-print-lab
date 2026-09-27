<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { integrationGlyph } from '$lib/client/integrations';

	const { lab } = useApp();
	// The printer has its own nav entry; the always-on engine needs no light.
	const items = $derived(
		(lab.integrations?.items ?? []).filter(
			(i) => i.id !== 'printer' && i.id !== 'openscad' && (i.id !== 'anthropic-api' || i.available)
		)
	);
	// Packages add many integrations; the bar shows the first few and a count, the page lists them all.
	const FIRST = 4;
	const first = $derived(items.slice(0, FIRST));
	const more = $derived(items.length - first.length);
	const summary = $derived(
		items.length
			? items.map((i) => `${i.name}: ${i.available ? 'ready' : 'not ready'}`).join(' · ')
			: 'Checking integrations…'
	);
</script>

<a
	class="integrations-pill"
	class:active={page.url.pathname.startsWith('/integrations')}
	href={resolve('/integrations')}
	title="Integrations — {summary}"
	aria-label="Integrations: {summary}"
>
	{#if items.length}
		{#each first as i (i.id)}
			<span class="tool" class:ok={i.available}
				><span class="glyph" aria-hidden="true">{integrationGlyph(i.id)}</span><span class="name"
					>{i.name}</span
				><i></i></span
			>
		{/each}
		{#if more > 0}<span class="tool more" aria-hidden="true">+{more}</span>{/if}
	{:else}
		<span class="tool checking">Integrations…</span>
	{/if}
</a>

<style>
	.integrations-pill {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		height: 28px;
		padding: 0 4px;
		border-radius: 999px;
		text-decoration: none;
		color: var(--muted);
		transition:
			background 0.15s,
			box-shadow 0.15s;
	}
	.integrations-pill:hover,
	.integrations-pill.active {
		background: rgb(var(--hi) / 0.07);
		color: var(--text);
	}
	.tool {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 8px 3px 6px;
		border-radius: 999px;
		font-size: 12px;
		white-space: nowrap;
	}
	.glyph {
		font-size: 12px;
		color: var(--dim);
	}
	.ok .glyph {
		color: var(--cyan);
	}
	.tool i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--red);
	}
	.tool.ok i {
		background: var(--lime);
		box-shadow: 0 0 6px rgb(var(--c3) / 0.7);
	}
	.checking {
		color: var(--dim);
		padding: 3px 8px;
	}
	.more {
		font: 500 11px var(--mono);
		color: var(--dim);
	}
	@media (max-width: 2099px) {
		.name {
			display: none;
		}
		.tool {
			padding: 3px 6px;
		}
	}
	@media (max-width: 900px) {
		.integrations-pill {
			display: none;
		}
	}
</style>
