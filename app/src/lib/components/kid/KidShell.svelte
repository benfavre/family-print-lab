<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import type { KidLevel } from '$lib/shared/domain';
	import Avatar from '../Avatar.svelte';
	import PinPad from './PinPad.svelte';

	let { kid, children }: { kid: { id: string; name: string; level: KidLevel }; children: Snippet } =
		$props();
	const { lab } = useApp();
	const profile = $derived(lab.profile(kid.id));
	let pinOpen = $state(false);

	async function leave(pin: string) {
		const response = await fetch('/api/kid/exit', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pin })
		}).catch(() => null);
		if (!response) return 'Could not reach the app. Try again.';
		if (!response.ok)
			return (await response.json().catch(() => ({}))).error ?? 'That did not work.';
		pinOpen = false;
		await goto(resolve('/'), { invalidateAll: true });
	}
</script>

<div class="kid-shell" class:little={kid.level === 'little'} data-kid-level={kid.level}>
	<header class="kid-top">
		{#if page.url.pathname !== '/kid'}
			<a class="kid-round" href={resolve('/kid')} aria-label="Home">🏠</a>
		{/if}
		<div class="kid-hello">
			<span class="kid-avatar"><Avatar {profile} /></span>
			<span>Hi, {kid.name}!</span>
		</div>
		<button class="kid-grownups" onclick={() => (pinOpen = true)}>🔒 Grown-ups</button>
	</header>
	<main id="main" tabindex="-1">{@render children()}</main>
</div>
{#if pinOpen}
	<PinPad
		title="Grown-ups only"
		text="Enter the parent PIN to leave kid mode."
		submitLabel="Leave kid mode"
		onsubmit={leave}
		onclose={() => (pinOpen = false)}
	/>
{/if}

<style>
	.kid-shell {
		--k-bg: #fff6ea;
		--k-card: #ffffff;
		--k-ink: #2b2140;
		--k-muted: #6f6485;
		--k-line: #f1e2cf;
		--k-sun: #ffb938;
		--k-berry: #ff4f86;
		--k-sky: #3aa7ff;
		--k-leaf: #25b877;
		--k-grape: #8b6bff;
		--k-focus: #8b6bff;
		color-scheme: light;
		min-height: 100svh;
		padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
			max(32px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
		color: var(--k-ink);
		background:
			radial-gradient(circle at 12% 8%, #ffe3b8 0, transparent 32%),
			radial-gradient(circle at 92% 18%, #ffd6e6 0, transparent 30%),
			radial-gradient(circle at 70% 96%, #d9ecff 0, transparent 34%), var(--k-bg);
		font-size: 18px;
		line-height: 1.4;
	}
	.kid-shell :global(:focus-visible) {
		outline: 4px solid var(--k-focus);
		outline-offset: 3px;
	}
	main {
		max-width: 1100px;
		margin: 0 auto;
		outline: none;
	}
	.kid-top {
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: 1100px;
		margin: 0 auto 20px;
	}
	.kid-hello {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-right: auto;
		font-size: 24px;
		font-weight: 750;
		letter-spacing: -0.02em;
	}
	.kid-avatar :global(.avatar) {
		width: 48px;
		height: 48px;
		font-size: 18px;
	}
	.kid-round {
		display: grid;
		place-items: center;
		width: 56px;
		height: 56px;
		flex: none;
		border-radius: 50%;
		background: var(--k-card);
		box-shadow: 0 4px 0 var(--k-line);
		font-size: 28px;
		text-decoration: none;
	}
	.kid-grownups {
		min-height: 44px;
		padding: 8px 16px;
		border: 0;
		border-radius: 999px;
		background: rgb(43 33 64 / 0.07);
		color: var(--k-muted);
		font: 600 15px var(--sans);
		cursor: pointer;
	}
	.kid-grownups:hover {
		background: rgb(43 33 64 / 0.12);
	}
	/* Shared by the kid pages. */
	.kid-shell :global(.kid-title) {
		margin: 8px 0 18px;
		font-size: clamp(28px, 5vw, 40px);
		line-height: 1.1;
		letter-spacing: -0.03em;
	}
	.kid-shell :global(.kid-heading) {
		margin: 32px 0 14px;
		font-size: 22px;
		letter-spacing: -0.02em;
	}
	.kid-shell :global(.kid-button) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		min-height: 64px;
		padding: 12px 28px;
		border: 0;
		border-radius: 22px;
		color: #fff;
		background: var(--k-leaf);
		box-shadow: 0 5px 0 #1a8a58;
		font: 750 21px var(--sans);
		text-decoration: none;
		cursor: pointer;
	}
	.kid-shell :global(.kid-button:active) {
		transform: translateY(3px);
		box-shadow: 0 2px 0 #1a8a58;
	}
	.kid-shell :global(.kid-button:disabled) {
		opacity: 0.5;
		cursor: default;
		transform: none;
	}
	.kid-shell :global(.kid-button.berry) {
		background: var(--k-berry);
		box-shadow: 0 5px 0 #c42a61;
	}
	.kid-shell :global(.kid-button.plain) {
		color: var(--k-ink);
		background: var(--k-card);
		box-shadow: 0 5px 0 var(--k-line);
	}
	.kid-shell :global(.kid-status) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 12px;
		border-radius: 999px;
		background: #f6efe6;
		font-size: 15px;
		font-weight: 650;
	}
	.kid-shell :global(.kid-status.waiting) {
		background: #fff1cc;
	}
	.kid-shell :global(.kid-status.approved),
	.kid-shell :global(.kid-status.printing) {
		background: #dff1ff;
	}
	.kid-shell :global(.kid-status.made) {
		background: #d9f6e7;
	}
	.kid-shell :global(.kid-status.declined),
	.kid-shell :global(.kid-status.failed) {
		background: #ffe3ec;
	}
	.kid-shell :global(.kid-bar) {
		height: 14px;
		border-radius: 999px;
		background: #f1e2cf;
		overflow: hidden;
	}
	.kid-shell :global(.kid-bar i) {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: linear-gradient(90deg, var(--k-sky), var(--k-grape));
		transition: width 0.6s;
	}
	@media (max-width: 520px) {
		.kid-hello {
			font-size: 20px;
		}
		.kid-avatar :global(.avatar) {
			width: 40px;
			height: 40px;
		}
	}
</style>
