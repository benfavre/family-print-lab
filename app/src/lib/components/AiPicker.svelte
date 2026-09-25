<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { INTEGRATION_GLYPH } from '$lib/client/integrations';
	import { AI_PROVIDERS, AI_PROVIDER_NAME, type AiProviderId } from '$lib/shared/integrations';

	export type AiChoice = AiProviderId | 'both';
	let {
		value = $bindable(),
		allowBoth = false,
		disabled = false
	}: { value: AiChoice | null; allowBoth?: boolean; disabled?: boolean } = $props();
	const { lab } = useApp();

	// Ready providers (all of them until the status check has run), subscriptions first.
	const ready = $derived(
		AI_PROVIDERS.filter((p) => {
			const s = lab.integrations?.items.find((i) => i.id === p);
			return s ? s.available : p !== 'anthropic-api';
		})
	);
	const both = $derived(allowBoth && ready.includes('claude-code') && ready.includes('codex'));
	// Default to the provider Settings route design work to.
	$effect(() => {
		if (
			value === null ||
			(value !== 'both' && !ready.includes(value)) ||
			(value === 'both' && !both)
		) {
			const routed = lab.integrations?.routing.cad;
			value = routed && ready.includes(routed) ? routed : (ready[0] ?? null);
		}
	});
</script>

{#if ready.length}
	<span class="ai-picker" role="radiogroup" aria-label="Which AI">
		{#each ready as p (p)}
			<button
				type="button"
				role="radio"
				aria-checked={value === p}
				{disabled}
				onclick={() => (value = p)}
				><span aria-hidden="true">{INTEGRATION_GLYPH[p]}</span>{AI_PROVIDER_NAME[p]}</button
			>
		{/each}
		{#if both}
			<button
				type="button"
				role="radio"
				aria-checked={value === 'both'}
				{disabled}
				onclick={() => (value = 'both')}
				title="Ask Claude and ChatGPT at the same time and pick the better design">Both</button
			>
		{/if}
	</span>
{:else}
	<a class="no-ai" href={resolve('/integrations')}>No AI is ready — set one up in Integrations</a>
{/if}

<style>
	.ai-picker {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border-radius: var(--r-sm);
		background: rgb(var(--c2) / 0.06);
		box-shadow: 0 0 0 1px rgb(var(--c2) / 0.25) inset;
	}
	button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		padding: 4px 9px;
	}
	button span {
		font-size: 11px;
	}
	button[aria-checked='true'] {
		background: rgb(var(--c2) / 0.2);
		color: var(--text);
		box-shadow: 0 0 0 1px rgb(var(--c2) / 0.55) inset;
	}
	.no-ai {
		font-size: 12px;
		color: var(--amber);
	}
</style>
