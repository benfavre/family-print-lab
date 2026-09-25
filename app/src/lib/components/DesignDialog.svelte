<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { actions } from '$lib/client/actions';
	import { design, readImage } from '$lib/client/models';
	import type { AiProviderId } from '$lib/shared/integrations';
	import { usePanel } from '$lib/client/panel';
	import AiPicker, { type AiChoice } from './AiPicker.svelte';
	import DesignResult from './DesignResult.svelte';

	let {
		projectId,
		taskIds: initial = [],
		startImage,
		startPrompt,
		onclose
	}: {
		projectId: string;
		taskIds?: string[];
		/** Start from a picture, e.g. a sketch of the idea. */
		startImage?: { mediaType: string; data: string; url: string };
		startPrompt?: string;
		onclose: () => void;
	} = $props();
	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);
	const panel = usePanel();
	$effect(() => panel?.setTitle('✦ Design a part with AI'));

	// svelte-ignore state_referenced_locally
	let prompt = $state(startPrompt ?? '');
	// svelte-ignore state_referenced_locally
	let image = $state<{ mediaType: string; data: string; url: string } | null>(startImage ?? null);
	let error = $state('');
	let choice = $state<AiChoice | null>(null);
	// svelte-ignore state_referenced_locally
	let taskIds = $state<string[]>([...initial]);
	let starting = $state(false);
	let creating = $state(false);
	let now = $state(Date.now());
	const tasks = $derived(taskIds.map((id) => lab.taskFor(id)).filter((t) => !!t));
	const busy = $derived(starting || tasks.some((t) => t.status === 'running'));

	onMount(() => {
		// Reopened from Activity: show what was asked.
		const first = lab.taskFor(initial[0]);
		if (first && !prompt) prompt = first.title;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => {
			clearInterval(t);
			for (const id of taskIds) ui.watching.delete(id);
		};
	});
	$effect(() => {
		for (const id of taskIds) ui.watching.add(id);
	});

	const EXAMPLES = [
		'A wall hook for a backpack, screwed on with two screws',
		'A pencil cup 80 mm wide with a hexagon pattern',
		'A replacement knob for a 6 mm D-shaft, 30 mm across',
		'A small name tag keychain that says ALEX'
	];

	async function run(e?: SubmitEvent) {
		e?.preventDefault();
		if (!prompt.trim() || busy || !choice) return;
		error = '';
		starting = true;
		const providers: AiProviderId[] = choice === 'both' ? ['claude-code', 'codex'] : [choice];
		const request = {
			projectId,
			prompt: prompt.trim(),
			image: image && { mediaType: image.mediaType, data: image.data }
		};
		try {
			// Both AIs work at the same time, as background tasks; each result shows up when it is ready.
			const started = await Promise.all(
				providers.map((provider) => design({ ...request, provider }))
			);
			for (const { task } of started) if (!lab.taskFor(task.id)) lab.tasks = [task, ...lab.tasks];
			taskIds = started.map((r) => r.task.id);
		} catch (err) {
			error = (err as Error).message;
		} finally {
			starting = false;
		}
	}

	async function create(name: string, source: string, taskId: string) {
		creating = true;
		const id = await act.newModel(projectId, name, source, 'ai', taskId);
		creating = false;
		if (id) onclose();
	}
	function stop() {
		for (const t of tasks) if (t.status === 'running') void lab.taskAction(t.id, 'cancel');
	}

	async function attach(file: File | undefined) {
		error = '';
		if (!file) return;
		try {
			image = await readImage(file);
		} catch (err) {
			error = (err as Error).message;
		}
	}
</script>

<form class="design in-panel" onsubmit={run}>
	<div class="design-body" class:two={tasks.length > 1}>
		<div class="design-left">
			<label class="field"
				>What should it be?<textarea
					bind:value={prompt}
					rows="6"
					maxlength="4000"
					placeholder="Say what it is for, the sizes that matter, and how it attaches or fits."
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run();
					}}></textarea></label
			>
			{#if !prompt}
				<div class="examples">
					{#each EXAMPLES as ex (ex)}<button
							type="button"
							class="chip"
							onclick={() => (prompt = ex)}>{ex}</button
						>{/each}
				</div>
			{/if}
			<div class="row">
				<label class="mini pick-image"
					>＋ Sketch or photo<input
						type="file"
						accept="image/jpeg,image/png,image/webp,image/gif"
						hidden
						onchange={(e) => attach(e.currentTarget.files?.[0])}
					/></label
				>
				{#if image}<img class="thumb" src={image.url} alt="Reference" /><button
						type="button"
						class="mini icon"
						aria-label="Remove image"
						onclick={() => (image = null)}>×</button
					>{/if}
			</div>
			{#if error}<p class="err" role="alert">{error}</p>{/if}
			<div class="who">
				<span>Designed by</span>
				<AiPicker bind:value={choice} allowBoth disabled={busy} />
			</div>
			<small class="via"
				>{choice === 'both'
					? 'Claude and ChatGPT design it at the same time; keep the one you like.'
					: 'Uses your subscription.'} The project's title and description are sent with the request.</small
			>
		</div>
		<div class="design-right">
			{#if tasks.length}
				{#each tasks as task (task.id)}
					<DesignResult
						{task}
						{now}
						compact={tasks.length > 1}
						{creating}
						oncreate={(name, source) => create(name, source, task.id)}
					/>
				{/each}
			{:else}
				<div class="placeholder">
					<span aria-hidden="true">⬡</span>
					<p>The design appears here, rendered and checked, before anything is saved.</p>
				</div>
			{/if}
		</div>
	</div>
	<footer class="dialog-actions">
		{#if busy}
			<button type="button" class="secondary" onclick={stop}>Stop</button>
			<small class="bg-note"
				>You can close this window; the design keeps going and appears in Activity.</small
			>
		{:else}
			<button class="primary ai-go" disabled={!prompt.trim() || !choice}
				>{tasks.length
					? '✦ Try again'
					: choice === 'both'
						? '✦ Design it with both'
						: '✦ Design it'}</button
			>
		{/if}
	</footer>
</form>

<style>
	.design {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.design-body {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
		gap: 16px;
	}
	.design-left {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}
	.design-left .field {
		margin: 0;
	}
	.design-right {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}
	.two .design-right {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}
	.bg-note {
		font-size: 12px;
		color: var(--dim);
		margin-left: 10px;
	}
	.placeholder {
		height: 420px;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 10px;
		border-radius: var(--r-lg);
		border: 1px dashed var(--line-strong);
		color: var(--dim);
		text-align: center;
		padding: 20px;
	}
	.placeholder span {
		font-size: 34px;
	}
	.placeholder p {
		margin: 0;
		max-width: 32ch;
		font-size: 13px;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12.5px;
		color: var(--muted);
	}
	.two {
		grid-template-columns: minmax(0, 0.8fr) minmax(0, 2fr) !important;
	}
	.examples {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.pick-image {
		cursor: pointer;
	}
	.thumb {
		width: 56px;
		height: 42px;
		object-fit: cover;
		border-radius: 6px;
		border: 1px solid var(--line);
	}
	.err {
		color: var(--err-text);
	}
	.err {
		margin: 0;
		font-size: 13px;
	}
	.via {
		color: var(--dim);
		font-size: 11.5px;
	}
	@media (max-width: 760px) {
		.design-body {
			grid-template-columns: 1fr;
		}
		.design-right {
			height: 300px;
		}
	}
	/* Docked in the corner the panel is narrow: stack the form above the results. */
	@container (max-width: 760px) {
		.design-body,
		.design-body.two {
			grid-template-columns: 1fr !important;
		}
		.two .design-right {
			grid-template-columns: 1fr;
		}
	}
</style>
