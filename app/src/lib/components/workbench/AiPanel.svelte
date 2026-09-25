<script lang="ts">
	import type { CadSuggestion } from '$lib/shared/cad';
	import { readImage } from '$lib/client/models';
	import { INTEGRATION_GLYPH } from '$lib/client/integrations';
	import { AI_PROVIDER_NAME, type AiProviderId } from '$lib/shared/integrations';
	import AiPicker, { type AiChoice } from '../AiPicker.svelte';

	export interface AiTurn {
		instruction: string;
		result: CadSuggestion | null;
		error: string | null;
		kept: boolean;
		undone: boolean;
		taskId: string | null;
	}

	let {
		busy,
		turns,
		pending,
		stage = '',
		onask,
		oncancel,
		onkeep,
		onundo
	}: {
		busy: boolean;
		turns: AiTurn[];
		/** The latest suggestion is applied to the editor but not saved yet. */
		pending: boolean;
		/** Live progress of the running change. */
		stage?: string;
		onask: (
			instruction: string,
			image: { mediaType: string; data: string } | null,
			provider: AiProviderId | null
		) => void;
		oncancel: () => void;
		onkeep: () => void;
		onundo: () => void;
	} = $props();

	let instruction = $state('');
	let choice = $state<AiChoice | null>(null);
	let image = $state<{ mediaType: string; data: string; url: string } | null>(null);
	let imageError = $state('');
	let started = $state(0);
	let now = $state(0);

	$effect(() => {
		if (!busy) return;
		started = now = Date.now();
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	const IDEAS = [
		'Make it 20% bigger',
		'Add two screw holes for mounting',
		'Round all the outside edges',
		'Make the walls thicker and sturdier',
		'Add a snap-on lid',
		'Put a name on the front'
	];

	function submit(e?: SubmitEvent) {
		e?.preventDefault();
		if (!instruction.trim() || busy) return;
		onask(
			instruction.trim(),
			image && { mediaType: image.mediaType, data: image.data },
			choice === 'both' ? null : choice
		);
		instruction = '';
		image = null;
	}
	async function attach(file: File | undefined) {
		imageError = '';
		if (!file) return;
		try {
			image = await readImage(file);
		} catch (error) {
			imageError = (error as Error).message;
		}
	}
</script>

<div class="ai-panel">
	<form class="ai-ask" onsubmit={submit}>
		<textarea
			bind:value={instruction}
			rows="3"
			maxlength="4000"
			placeholder="Describe a change, e.g. “make room for a 60 mm phone and add a cable slot”"
			aria-label="Change to make with AI"
			onkeydown={(e) => {
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
			}}></textarea>
		{#if image}
			<div class="ai-attachment">
				<img src={image.url} alt="Reference for the AI" />
				<button
					type="button"
					class="mini icon"
					aria-label="Remove image"
					onclick={() => (image = null)}>×</button
				>
			</div>
		{/if}
		{#if imageError}<p class="err">{imageError}</p>{/if}
		<div class="ai-row">
			<label class="mini pick-image" title="Attach a sketch or photo"
				>＋ Image<input
					type="file"
					accept="image/jpeg,image/png,image/webp,image/gif"
					hidden
					onchange={(e) => attach(e.currentTarget.files?.[0])}
				/></label
			>
			{#if busy}
				<button type="button" class="mini" onclick={oncancel}>Stop</button>
				<span class="thinking"
					><span class="spinner"></span>{stage || 'Working…'}
					{Math.max(0, Math.round((now - started) / 1000))}s</span
				>
			{:else}
				<button class="mini ai primary-ai" disabled={!instruction.trim()}>✦ Apply change</button>
			{/if}
		</div>
		<div class="picker-row"><span>Ask</span><AiPicker bind:value={choice} disabled={busy} /></div>
		<small class="via"
			>The AI writes OpenSCAD; every attempt is compiled here and errors go back to it (up to 3
			tries).</small
		>
	</form>

	{#if !turns.length}
		<div class="ideas">
			{#each IDEAS as idea (idea)}
				<button type="button" class="chip" onclick={() => (instruction = idea)}>{idea}</button>
			{/each}
		</div>
	{/if}

	<ol class="turns">
		{#each [...turns].reverse() as turn, i (turns.length - i)}
			<li class:faded={turn.undone}>
				<p class="ask">{turn.instruction}</p>
				{#if turn.error}
					<p class="err">{turn.error}</p>
				{:else if turn.result}
					<p class="answer">
						<span class="by" title="Answered in {turn.result.seconds} s"
							>{INTEGRATION_GLYPH[turn.result.provider]}
							{AI_PROVIDER_NAME[turn.result.provider]}</span
						>
						{turn.result.summary}
					</p>
					<p class="meta">
						{#if turn.result.render.ok}
							<span class="ok">Renders</span> · {turn.result.render.triangles.toLocaleString()} triangles
						{:else}
							<span class="bad">Still has errors</span> — see Problems
						{/if}
						{#if turn.result.attempts > 1}· fixed itself in {turn.result.attempts} tries{/if}
						{#if turn.kept}· <span class="ok">saved</span>{/if}
						{#if turn.undone}· undone{/if}
					</p>
					{#if i === 0 && pending && !turn.kept && !turn.undone}
						<div class="ai-row">
							<button
								type="button"
								class="mini primary-mini"
								onclick={onkeep}
								disabled={!turn.result.render.ok}>Keep as new version</button
							>
							<button type="button" class="mini" onclick={onundo}>Undo</button>
						</div>
					{/if}
				{/if}
			</li>
		{/each}
	</ol>
</div>

<style>
	.ai-panel {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.ai-ask {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	textarea {
		width: 100%;
		resize: vertical;
		min-height: 72px;
		border: 1px solid rgb(var(--c2) / 0.35);
		border-radius: var(--r-md);
		padding: 9px 11px;
		background: rgb(var(--c2) / 0.04);
		color: var(--text);
		font: 400 13px/1.5 var(--sans);
	}
	textarea:focus {
		outline: none;
		border-color: rgb(var(--c2) / 0.7);
		box-shadow: 0 0 0 3px rgb(var(--c2) / 0.14);
	}
	.ai-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.pick-image {
		cursor: pointer;
	}
	.primary-ai {
		margin-left: auto;
	}
	.via {
		color: var(--dim);
		font-size: 11.5px;
		line-height: 1.45;
	}
	.thinking {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-left: auto;
		font-size: 12px;
		color: var(--c2-text);
		font-variant-numeric: tabular-nums;
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
	.ideas {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.turns {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.turns li {
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		padding: 10px 12px;
		background: rgb(var(--hi) / 0.02);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.turns li.faded {
		opacity: 0.55;
	}
	.turns p {
		margin: 0;
		font-size: 12.5px;
	}
	.picker-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--muted);
	}
	.by {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-right: 6px;
		padding: 0 7px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		color: var(--c2-text);
		background: rgb(var(--c2) / 0.14);
	}
	.ask {
		color: var(--muted);
	}
	.answer {
		color: var(--text);
	}
	.meta {
		color: var(--dim);
		font-size: 11.5px !important;
	}
	.ok {
		color: var(--lime);
	}
	.bad,
	.err {
		color: var(--err-text);
	}
	.err {
		font-size: 12px;
		margin: 0;
	}
	.ai-attachment {
		position: relative;
		width: 88px;
	}
	.ai-attachment img {
		width: 88px;
		height: 66px;
		object-fit: cover;
		border-radius: var(--r-sm);
		border: 1px solid var(--line);
	}
	.ai-attachment button {
		position: absolute;
		top: 2px;
		right: 2px;
		background: rgb(var(--base) / 0.8);
	}
</style>
