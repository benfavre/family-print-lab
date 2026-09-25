<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { NAV } from '$lib/client/nav';

	// Phones: the sections live in a tab bar at the bottom, within thumb reach.
	const { lab } = useApp();
	const openJobs = $derived(
		lab.ws.jobs.filter((j) => j.status === 'Queued' || j.status === 'Printing').length
	);
</script>

<nav class="bottom-nav" aria-label="Sections">
	<!-- eslint-disable svelte/no-navigation-without-resolve -- NAV hrefs are built with resolve() in nav.ts -->
	{#each NAV as item (item.href)}
		{@const active = item.match(page.url.pathname)}
		<a
			href={item.href}
			class:active
			class:tab-live={item.href === resolve('/printer') && lab.printerActive}
			aria-current={active ? 'page' : undefined}
		>
			<span class="tab-icon"
				><svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true"
					><path
						d={item.icon}
						fill="none"
						stroke="currentColor"
						stroke-width="1.3"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>{#if item.href === resolve('/jobs') && openJobs}<b>{openJobs}</b>{/if}</span
			>
			<span class="tab-label">{item.label === 'Print jobs' ? 'Jobs' : item.label}</span>
		</a>
	{/each}
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
</nav>

<style>
	.bottom-nav {
		display: none;
	}
	@media (max-width: 700px) {
		.bottom-nav {
			position: fixed;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 30;
			display: grid;
			grid-template-columns: repeat(5, 1fr);
			padding: 6px 6px calc(6px + env(safe-area-inset-bottom));
			background: rgb(var(--base) / 0.88);
			backdrop-filter: blur(14px);
			border-top: 1px solid var(--line);
		}
		a {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 3px;
			padding: 5px 0 3px;
			border-radius: 10px;
			text-decoration: none;
			color: var(--dim);
			font-size: 10.5px;
			font-weight: 500;
		}
		a.active {
			color: var(--text);
		}
		a.active .tab-icon {
			color: var(--cyan);
			background: rgb(var(--c1) / 0.12);
		}
		.tab-icon {
			position: relative;
			display: grid;
			place-items: center;
			width: 44px;
			height: 28px;
			border-radius: 999px;
			transition: background 0.15s;
		}
		.tab-live .tab-icon::after {
			content: '';
			position: absolute;
			top: 3px;
			right: 9px;
			width: 7px;
			height: 7px;
			border-radius: 50%;
			background: var(--amber);
		}
		b {
			position: absolute;
			top: -2px;
			right: 2px;
			min-width: 16px;
			height: 16px;
			padding: 0 4px;
			border-radius: 999px;
			display: grid;
			place-items: center;
			font: 600 10px var(--sans);
			background: var(--cyan);
			color: var(--on-accent);
		}
	}
</style>
