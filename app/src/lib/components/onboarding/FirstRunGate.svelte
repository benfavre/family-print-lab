<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import type { OnboardingState } from '$lib/shared/onboarding';

	// Sits in the profile chooser. On a brand new lab (nobody in the family, no printers, the guide
	// never finished or skipped) it enters as Everyone and opens the setup guide; otherwise, while the
	// family is still empty, it offers the guide as a link.
	const { lab, ui } = useApp();
	let onboarding = $state<OnboardingState | null>(null);

	onMount(async () => {
		if (lab.ws.profiles.length) return;
		onboarding = await fetch('/api/onboarding')
			.then((r) => (r.ok ? r.json() : null))
			.catch(() => null);
		if (!onboarding?.firstRun) return;
		// Navigate first: entering removes the chooser, and this component with it.
		if (page.route.id !== '/welcome') await goto(resolve('/welcome'));
		ui.selectProfile('all');
	});

	async function open() {
		await goto(resolve('/welcome'));
		ui.selectProfile('all');
	}
</script>

{#if onboarding && !onboarding.firstRun && !lab.ws.profiles.length}
	<p class="first-run">
		New here? <button type="button" onclick={open}>Open the setup guide</button>
	</p>
{/if}

<style>
	.first-run {
		margin: 18px 0 0;
		font-size: 13.5px;
		color: var(--muted);
	}
	.first-run button {
		border: 0;
		padding: 0;
		background: none;
		color: var(--cyan);
		font: inherit;
		text-decoration: underline;
	}
</style>
