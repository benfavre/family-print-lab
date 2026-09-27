<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import {
		MODULE_LABELS,
		SEVERITY_LABELS,
		type HmsActionView,
		type HmsAlert
	} from '$lib/shared/hms';

	// One printer alert in plain words: severity, text, code, Bambu's picture, a wiki link and the
	// buttons Bambu defines for it.
	let {
		alert,
		printerId,
		ondone
	}: { alert: HmsAlert; printerId: string | null; ondone?: () => void } = $props();
	const { lab, ui } = useApp();
	let busy = $state(0);

	async function press(a: HmsActionView) {
		if (!printerId || busy) return;
		if (
			a.risk !== 'safe' &&
			!(await ui.ask(
				`${a.label}?`,
				`${alert.text} The printer gets the answer straight away.`,
				a.label
			))
		)
			return;
		busy = a.id;
		try {
			const res = await lab.call(
				'POST',
				`/api/printers/${printerId}/hms/action`,
				{ code: alert.key, actionId: a.id },
				'Sent to the printer.'
			);
			if (res) ondone?.();
		} finally {
			busy = 0;
		}
	}
</script>

<article class="hms-alert sev-{alert.severity}">
	<div class="hms-top">
		<span class="hms-sev"
			><span class="dot" aria-hidden="true"></span>{SEVERITY_LABELS[alert.severity]}</span
		>
		<span class="hms-module">{MODULE_LABELS[alert.module] ?? MODULE_LABELS.unknown}</span>
		<code>{alert.code}</code>
	</div>
	<p class="hms-text">{alert.text}</p>
	{#if alert.image}
		<details class="hms-picture">
			<summary>Show Bambu’s picture</summary>
			<img src={alert.image} alt="What to check for {alert.code}" loading="lazy" />
		</details>
	{/if}
	<div class="hms-actions">
		{#each alert.actions as a (a.id)}
			<button
				class="mini"
				class:primary-mini={a.risk === 'safe'}
				class:danger-mini={a.risk !== 'safe'}
				disabled={!printerId || !!busy}
				onclick={() => press(a)}>{busy === a.id ? 'Sending…' : a.label}</button
			>
		{/each}
		{#if alert.wikiUrl}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external wiki page -->
			<a class="mini" href={alert.wikiUrl} target="_blank" rel="noopener noreferrer">Learn more ↗</a
			>
		{/if}
	</div>
</article>

<style>
	.hms-alert {
		--sev: var(--muted);
		padding: 10px 12px;
		border-radius: var(--r-md);
		background: color-mix(in srgb, var(--sev) 7%, transparent);
		border: 1px solid color-mix(in srgb, var(--sev) 30%, transparent);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.sev-fatal,
	.sev-serious {
		--sev: var(--red);
	}
	.sev-common {
		--sev: var(--amber);
	}
	.sev-info {
		--sev: var(--blue);
	}
	.hms-top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--muted);
	}
	.hms-sev {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		color: var(--sev);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--sev);
	}
	.hms-top code {
		margin-left: auto;
	}
	.hms-text {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--text);
	}
	.hms-picture summary {
		cursor: pointer;
		font-size: 12.5px;
		color: var(--muted);
	}
	.hms-picture img {
		display: block;
		width: 100%;
		max-width: 360px;
		margin-top: 6px;
		border-radius: var(--r-sm);
	}
	.hms-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
</style>
