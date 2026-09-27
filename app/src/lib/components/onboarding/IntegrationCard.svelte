<script lang="ts">
	import type { Snippet } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { integrationGlyph } from '$lib/client/integrations';
	import type { IntegrationStatus, IntegrationTest } from '$lib/shared/integrations';

	// One integration: whether it is ready, what it powers, how to set it up, a real test and a link
	// to its settings. Used by the Integrations page and the setup guide.
	let {
		item,
		settingsHref = null,
		testable = true,
		children,
		actions
	}: {
		item: IntegrationStatus;
		/** Where it is set up (an anchor on the Integrations page, or another page). */
		settingsHref?: string | null;
		/** Rows without a server test (Print Lab Cloud) hide the Test button. */
		testable?: boolean;
		/** Extra fields under what it powers (the AI model, for example). */
		children?: Snippet;
		/** Extra buttons beside Test. */
		actions?: Snippet;
	} = $props();
	const { lab, ui } = useApp();

	const TEST_LABEL: Record<string, string> = {
		ai: 'Say hello',
		blender: 'Repair a test mesh',
		openscad: 'Render a test part',
		printer: 'Check the connections',
		slicer: 'Slice a test cube',
		module: 'Check'
	};

	let running = $state(false);
	let result = $state<IntegrationTest | null>(null);

	async function test() {
		running = true;
		result = null;
		try {
			const r = await fetch(`/api/integrations/${encodeURIComponent(item.id)}/test`, {
				method: 'POST'
			});
			const data = await r.json();
			result = r.ok ? data : { ok: false, ms: 0, detail: data.error ?? 'Test failed.' };
		} catch {
			result = { ok: false, ms: 0, detail: 'Could not reach the app server.' };
		} finally {
			running = false;
		}
		void lab.loadIntegrations();
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			ui.toast('Copied.');
		} catch {
			ui.toast(text);
		}
	}
	const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
</script>

<article
	class="int-card"
	class:ready={item.available}
	data-integration={item.id}
	id="integration-{item.id}"
	aria-labelledby="integration-{item.id}-name"
>
	<header>
		<span class="mark" aria-hidden="true">{integrationGlyph(item.id)}</span>
		<div class="title">
			<h3 id="integration-{item.id}-name">{item.name}</h3>
			<span class="via">{item.via}</span>
		</div>
		<span class="state">{item.available ? 'Ready' : 'Not ready'}</span>
	</header>
	<p class="int-detail">
		{item.detail}{#if item.version && item.kind !== 'ai'}<br /><span class="version"
				>{item.version}</span
			>{/if}
	</p>
	{#if item.powers.length}
		<div class="powers" aria-label="Used for">
			{#each item.powers as p (p)}<span>{p}</span>{/each}
		</div>
	{:else if item.kind === 'ai'}
		<p class="idle">Not used for anything yet.</p>
	{/if}
	{@render children?.()}
	{#if !item.available && item.setup.length}
		<ol class="int-setup" aria-label="How to set up {item.name}">
			{#each item.setup as step (step.text)}
				<li>
					<span>{step.text}</span>
					{#if step.command}
						<span class="cmd"
							><code>{step.command}</code><button
								type="button"
								class="mini icon"
								aria-label="Copy command"
								onclick={() => copy(step.command!)}>⧉</button
							></span
						>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
	<div class="int-actions">
		{#if testable}
			<button class="mini" disabled={running} onclick={test}
				>{running
					? 'Testing…'
					: `Test: ${TEST_LABEL[item.id] ?? TEST_LABEL[item.kind] ?? 'Check'}`}</button
			>
		{/if}
		{@render actions?.()}
		{#if settingsHref}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built with resolve() by the caller, plus an anchor -->
			<a class="mini settings-link" href={settingsHref}>Settings</a>
		{/if}
	</div>
	{#if result}
		<p class="result" class:bad={!result.ok} role="status">
			{result.ok ? '✓' : '✕'}
			{result.detail}
			{#if result.ms}<span class="ms">{seconds(result.ms)}</span>{/if}
		</p>
	{/if}
</article>

<style>
	.int-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px;
		border-radius: var(--r-lg);
		border: 1px solid var(--line);
		background: var(--panel);
		scroll-margin-top: 80px;
	}
	.int-card:target {
		box-shadow: 0 0 0 2px rgb(var(--c1) / 0.5);
	}
	.int-card.ready {
		border-color: rgb(var(--c3) / 0.3);
	}
	.int-card > header {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.mark {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		flex-shrink: 0;
		border-radius: 10px;
		font-size: 18px;
		color: var(--dim);
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
	}
	.ready .mark {
		color: var(--cyan);
		background: rgb(var(--c1) / 0.1);
		box-shadow: 0 0 0 1px rgb(var(--c1) / 0.3) inset;
	}
	.title {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.title h3 {
		margin: 0;
		font-size: 15px;
	}
	.via {
		font-size: 12px;
		color: var(--dim);
	}
	.state {
		font-size: 11.5px;
		padding: 2px 9px;
		border-radius: 999px;
		white-space: nowrap;
		color: var(--err-text);
		box-shadow: 0 0 0 1px rgb(var(--c5) / 0.4) inset;
	}
	.ready .state {
		color: var(--lime);
		box-shadow: 0 0 0 1px rgb(var(--c3) / 0.4) inset;
	}
	.int-detail {
		margin: 0;
		font-size: 12.5px;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	.version {
		font: 11.5px var(--mono);
		color: var(--dim);
	}
	.powers {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.powers span {
		font-size: 11.5px;
		padding: 2px 8px;
		border-radius: 999px;
		background: rgb(var(--c1) / 0.08);
		color: var(--text-2);
	}
	.idle {
		margin: 0;
		font-size: 12px;
		color: var(--dim);
	}
	.int-setup {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 12.5px;
		color: var(--amber);
	}
	.int-setup li > span:first-child {
		color: var(--text-2);
	}
	.cmd {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 3px;
	}
	.cmd code {
		flex: 1;
		font-size: 11.5px;
		padding: 5px 8px;
		border-radius: 6px;
		background: rgb(var(--hi) / 0.05);
		color: var(--text);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.int-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		align-items: center;
		margin-top: auto;
		padding: 0;
	}
	.settings-link {
		text-decoration: none;
	}
	.result {
		margin: 0;
		font-size: 12.5px;
		color: var(--lime);
		line-height: 1.45;
	}
	.result.bad {
		color: var(--err-text);
	}
	.ms {
		color: var(--dim);
		margin-left: 6px;
		font-variant-numeric: tabular-nums;
	}
</style>
