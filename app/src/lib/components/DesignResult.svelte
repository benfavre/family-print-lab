<script lang="ts">
	import { decodeStl, preview } from '$lib/client/models';
	import { INTEGRATION_GLYPH } from '$lib/client/integrations';
	import type { ModelViewer as Viewer } from '$lib/client/viewer';
	import type { TaskInfo } from '$lib/shared/tasks';
	import { AI_PROVIDER_NAME } from '$lib/shared/integrations';
	import ModelViewer from './ModelViewer.svelte';

	let {
		task,
		now,
		compact = false,
		creating = false,
		oncreate
	}: {
		task: TaskInfo;
		now: number;
		compact?: boolean;
		creating?: boolean;
		oncreate: (name: string, source: string) => void;
	} = $props();

	let viewer = $state<Viewer | null>(null);
	let panel = $state<ReturnType<typeof ModelViewer>>();
	let name = $state('');
	let loading = $state(false);
	const provider = $derived(task.provider ?? 'claude-code');
	const result = $derived(task.suggestion);
	const error = $derived(
		task.status === 'failed'
			? task.error || 'Failed.'
			: task.status === 'cancelled'
				? 'Stopped.'
				: ''
	);
	const running = $derived(task.status === 'running');
	let shown = '';

	// Show the design as soon as it arrives.
	$effect(() => {
		if (!result || !viewer || shown === task.id) return;
		shown = task.id;
		name = result.name || 'AI design';
		if (!result.render.ok) return;
		loading = true;
		preview(result.source, {})
			.then((p) => {
				if (p.stl) {
					viewer?.load(decodeStl(p.stl));
					panel?.refresh();
				}
			})
			.catch(() => {})
			.finally(() => (loading = false));
	});
</script>

<article class="design-result" class:compact class:failed={!!error}>
	<header>
		<span class="who"
			><span aria-hidden="true">{INTEGRATION_GLYPH[provider]}</span>{AI_PROVIDER_NAME[
				provider
			]}</span
		>
		{#if running}
			<span class="dr-status"
				><span class="spinner"></span>{task.stage}
				{Math.max(0, Math.round((now - Date.parse(task.startedAt)) / 1000))} s</span
			>
		{:else if error}
			<span class="dr-status bad">{task.status === 'cancelled' ? 'Stopped' : 'Failed'}</span>
		{:else if result}
			<span class="dr-status"
				>{result.seconds} s ·
				{#if result.render.ok}<span class="ok">Renders</span>{:else}<span class="bad"
						>Does not render</span
					>{/if}{#if result.attempts > 1}
					· fixed itself in {result.attempts} tries{/if}</span
			>
		{/if}
	</header>
	<div class="view">
		<ModelViewer
			bind:this={panel}
			bind:viewer
			busy={loading}
			empty={error ? '' : running ? '' : 'No preview.'}
		/>
	</div>
	{#if error}
		<p class="err" role="alert">{error}</p>
	{:else if result}
		<p class="summary">{result.summary}</p>
		<div class="use">
			<input
				bind:value={name}
				maxlength="80"
				aria-label="Name for the {AI_PROVIDER_NAME[provider]} design"
			/>
			<button
				type="button"
				class="primary"
				disabled={creating || !!task.usedBy}
				onclick={() => oncreate(name.trim() || 'AI design', result!.source)}
				>{task.usedBy ? 'Already used' : compact ? 'Use this one' : 'Create model'}</button
			>
		</div>
	{/if}
</article>

<style>
	.design-result {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		min-height: 0;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		font-size: 12.5px;
	}
	.who {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		color: var(--text);
	}
	.who span {
		color: var(--violet);
	}
	.dr-status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--dim);
		font-variant-numeric: tabular-nums;
	}
	.view {
		height: 360px;
	}
	.compact .view {
		height: 260px;
	}
	.view :global(.viewer) {
		min-height: 0;
	}
	.summary {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--text-2);
		max-height: 7.5em;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.use {
		display: flex;
		gap: 8px;
	}
	.use input {
		flex: 1;
		min-width: 0;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-md);
		padding: 0 10px;
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		font: 13px var(--sans);
	}
	.ok {
		color: var(--lime);
	}
	.bad,
	.err {
		color: var(--err-text);
	}
	.err {
		margin: 0;
		font-size: 12.5px;
	}
	.spinner {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 2px solid rgb(var(--c2) / 0.25);
		border-top-color: var(--violet);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
</style>
