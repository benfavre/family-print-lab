<script lang="ts" module>
	/** What the ✦ menu offers (the server holds the matching instructions). */
	export const AI_ACTIONS = {
		flesh: '✦ Flesh out the idea',
		clarify: 'Make it clearer',
		questions: 'List what to decide first',
		measure: 'What to measure and record',
		tidy: 'Tidy up',
		files: 'Organise the file names',
		interests: 'Describe their interests',
		checklist: 'Add a post-print checklist'
	} as const;
	export type AiAction = keyof typeof AI_ACTIONS;
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';

	let {
		label,
		value = $bindable(''),
		maxlength = 4000,
		hint = '',
		placeholder = '',
		ai
	}: {
		label: string;
		value: string;
		maxlength?: number;
		hint?: string;
		placeholder?: string;
		/** AI writing help: the actions to offer and the project context to send with them. */
		ai?: { actions: AiAction[]; context: () => Record<string, string> };
	} = $props();
	const { lab } = useApp();

	// ---------- AI writing help ----------
	let menuOpen = $state(false);
	let suggestion = $state('');
	let writing = $state(false);
	let aiError = $state('');
	let lastAction = $state<AiAction | null>(null);
	let abort: AbortController | null = null;

	async function write(action: AiAction) {
		if (!ai) return;
		menuOpen = false;
		abort?.abort();
		abort = new AbortController();
		lastAction = action;
		suggestion = '';
		aiError = '';
		writing = true;
		try {
			const r = await fetch('/api/ai/write', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, field: label, text: value, context: ai.context() }),
				signal: abort.signal
			});
			if (!r.ok || !r.body)
				throw new Error((await r.json().catch(() => ({}))).error ?? 'The AI is not available.');
			const reader = r.body.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { done, value: chunk } = await reader.read();
				if (done) break;
				suggestion += decoder.decode(chunk, { stream: true });
			}
			suggestion = suggestion.trim();
		} catch (error) {
			if ((error as Error).name !== 'AbortError') aiError = (error as Error).message;
		} finally {
			writing = false;
		}
	}
	function accept(mode: 'replace' | 'append') {
		const text = suggestion.trim();
		value = (mode === 'replace' || !value.trim() ? text : `${value.trimEnd()}\n\n${text}`).slice(
			0,
			maxlength
		);
		dismiss();
	}
	function outside(e: MouseEvent) {
		if (menuOpen && !(e.target as HTMLElement).closest('.ai-wrap')) menuOpen = false;
	}
	function dismiss() {
		abort?.abort();
		suggestion = '';
		aiError = '';
		writing = false;
	}

	const id = $props.id();
	let expanded = $state(false);
	let small = $state<HTMLTextAreaElement>();
	let big = $state<HTMLTextAreaElement>();
	let panel = $state<HTMLDivElement>();

	async function open() {
		const cursor = small?.selectionStart ?? value.length;
		expanded = true;
		// The panel covers the dialog's visible area, so start from its top.
		const scroller = (panel ?? small)?.closest<HTMLElement>('dialog, .fp-body');
		if (scroller) scroller.scrollTop = 0;
		await tick();
		big?.focus();
		big?.setSelectionRange(cursor, cursor);
	}
	async function close() {
		const cursor = big?.selectionStart ?? value.length;
		expanded = false;
		await tick();
		small?.focus();
		small?.setSelectionRange(cursor, cursor);
	}
	function keys(e: KeyboardEvent) {
		// Esc or Ctrl+Enter returns to the form; Esc must not close the whole dialog.
		if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
			e.preventDefault();
			e.stopPropagation();
			void close();
		}
	}
</script>

<svelte:window onclick={outside} />

<div class="field expandable" bind:this={panel}>
	<span class="label-row">
		<label for={id}>{label}</label>
		{#if ai}
			<span class="ai-wrap">
				<button
					type="button"
					class="expand ai-btn"
					title="Write with AI"
					aria-label="Write {label} with AI"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					onclick={() => (menuOpen = !menuOpen)}>✦</button
				>
				{#if menuOpen}
					<span class="ai-menu" role="menu" aria-label="Write with AI">
						{#each ai.actions as a (a)}
							<button type="button" role="menuitem" onclick={() => write(a)}>{AI_ACTIONS[a]}</button
							>
						{/each}
						<small
							>Via {lab.ai.label || 'the configured AI'}; nothing changes until you accept.</small
						>
					</span>
				{/if}
			</span>
		{/if}
		<button
			type="button"
			class="expand"
			title="Open a larger editor"
			aria-label="Expand {label}"
			onclick={open}
			><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
				><path
					d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/></svg
			></button
		>
	</span>
	<textarea {id} bind:this={small} bind:value {maxlength} {placeholder}></textarea>
	{#if writing || suggestion || aiError}
		<div class="ai-suggestion" class:error={!!aiError} aria-live="polite">
			<header>
				<span class="ai-tag"
					>✦ {lastAction ? AI_ACTIONS[lastAction].replace('✦ ', '') : 'Suggestion'}</span
				>
				{#if writing}<span class="dots" aria-label="Writing"><i></i><i></i><i></i></span>{/if}
			</header>
			{#if aiError}<p>{aiError}</p>{:else}<p class="text">
					{suggestion}{#if writing}<span class="caret"></span>{/if}
				</p>{/if}
			<div class="ai-actions">
				{#if writing}
					<button type="button" class="mini" onclick={dismiss}>Stop</button>
				{:else if suggestion}
					<button type="button" class="mini primary-mini" onclick={() => accept('replace')}
						>Replace</button
					>
					<button type="button" class="mini" onclick={() => accept('append')}>Add below</button>
					<button type="button" class="mini" onclick={() => lastAction && write(lastAction)}
						>Try again</button
					>
					<button type="button" class="mini icon" aria-label="Discard suggestion" onclick={dismiss}
						>×</button
					>
				{:else}
					<button type="button" class="mini icon" aria-label="Close" onclick={dismiss}>×</button>
				{/if}
			</div>
		</div>
	{/if}
	{#if hint}<small>{hint}</small>{/if}
</div>

{#if expanded}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div class="text-expanded" role="group" aria-label="{label}, expanded" onkeydown={keys}>
		<header>
			<strong>{label}</strong>
			<span class="count">{value.length.toLocaleString()} / {maxlength.toLocaleString()}</span>
			<button type="button" class="primary" onclick={close}>Done</button>
		</header>
		<textarea bind:this={big} bind:value {maxlength} {placeholder} aria-label={label}></textarea>
		{#if ai}
			<div class="expanded-ai">
				{#each ai.actions as a (a)}<button type="button" class="mini ai" onclick={() => write(a)}
						>{AI_ACTIONS[a].startsWith('✦') ? AI_ACTIONS[a] : `✦ ${AI_ACTIONS[a]}`}</button
					>{/each}
			</div>
			{#if writing || suggestion || aiError}
				<div class="ai-suggestion" class:error={!!aiError} aria-live="polite">
					<header>
						<span class="ai-tag"
							>✦ {lastAction ? AI_ACTIONS[lastAction].replace('✦ ', '') : 'Suggestion'}</span
						>
						{#if writing}<span class="dots" aria-label="Writing"><i></i><i></i><i></i></span>{/if}
					</header>
					{#if aiError}<p>{aiError}</p>{:else}<p class="text">
							{suggestion}{#if writing}<span class="caret"></span>{/if}
						</p>{/if}
					<div class="ai-actions">
						{#if writing}
							<button type="button" class="mini" onclick={dismiss}>Stop</button>
						{:else if suggestion}
							<button type="button" class="mini primary-mini" onclick={() => accept('replace')}
								>Replace</button
							>
							<button type="button" class="mini" onclick={() => accept('append')}>Add below</button>
							<button type="button" class="mini" onclick={() => lastAction && write(lastAction)}
								>Try again</button
							>
							<button
								type="button"
								class="mini icon"
								aria-label="Discard suggestion"
								onclick={dismiss}>×</button
							>
						{:else}
							<button type="button" class="mini icon" aria-label="Close" onclick={dismiss}>×</button
							>
						{/if}
					</div>
				</div>
			{/if}
		{/if}
		<p class="expanded-help">
			<kbd>Esc</kbd> or <kbd>Ctrl</kbd> <kbd>Enter</kbd> to return to the form
		</p>
	</div>
{/if}

<style>
	.ai-wrap {
		position: relative;
		margin-left: auto;
	}
	.ai-btn {
		color: var(--violet) !important;
		font-size: 12px;
	}
	.ai-menu {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 20;
		display: flex;
		flex-direction: column;
		min-width: 230px;
		padding: 4px;
		border-radius: var(--r-md);
		border: 1px solid rgb(var(--c2) / 0.4);
		background: var(--menu);
		box-shadow: 0 16px 40px rgb(var(--lo) / 0.45);
	}
	.ai-menu button {
		border: 0;
		background: transparent;
		text-align: left;
		padding: 7px 10px;
		border-radius: 6px;
		font-size: 13px;
		color: var(--text);
	}
	.ai-menu button:hover,
	.ai-menu button:focus-visible {
		background: rgb(var(--c2) / 0.14);
		outline: none;
	}
	.ai-menu small {
		padding: 6px 10px 4px;
		font-size: 11px;
		color: var(--dim);
		font-weight: 400;
	}
	.ai-suggestion {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 6px;
		padding: 10px 12px;
		border-radius: var(--r-md);
		border: 1px solid rgb(var(--c2) / 0.4);
		background: rgb(var(--c2) / 0.06);
		font-weight: 400;
	}
	.ai-suggestion.error {
		border-color: rgb(var(--c5) / 0.45);
		background: rgb(var(--c5) / 0.06);
		color: var(--err-text);
	}
	.ai-suggestion header {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.ai-tag {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--c2-text);
	}
	.ai-suggestion p {
		margin: 0;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text);
		white-space: pre-wrap;
	}
	.ai-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.ai-actions .icon {
		margin-left: auto;
	}
	.caret {
		display: inline-block;
		width: 7px;
		height: 1em;
		margin-left: 2px;
		vertical-align: text-bottom;
		background: var(--violet);
		animation: blink 1s steps(2) infinite;
	}
	.dots {
		display: inline-flex;
		gap: 3px;
	}
	.dots i {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--violet);
		animation: blink 1s infinite;
	}
	.dots i:nth-child(2) {
		animation-delay: 0.2s;
	}
	.dots i:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes blink {
		50% {
			opacity: 0.2;
		}
	}
	.expanded-ai {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.text-expanded .ai-suggestion {
		max-height: 35%;
		overflow-y: auto;
	}
	.label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.label-row label {
		color: inherit;
	}
	.expand {
		display: grid;
		place-items: center;
		width: 24px;
		height: 22px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--dim);
		transition:
			color 0.15s,
			background 0.15s;
	}
	.expand:hover,
	.expand:focus-visible {
		color: var(--text);
		background: rgb(var(--hi) / 0.07);
	}
	.text-expanded {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 18px 20px 14px;
		background: var(--menu);
		animation: grow 0.16s ease-out;
	}
	.text-expanded header {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.text-expanded strong {
		font-size: 15px;
		flex: 1;
	}
	.count {
		font-size: 12px;
		color: var(--dim);
		font-variant-numeric: tabular-nums;
	}
	.text-expanded textarea {
		flex: 1;
		resize: none;
		width: 100%;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-md);
		padding: 14px 16px;
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		font: 400 15px/1.65 var(--sans);
	}
	.text-expanded textarea:focus {
		outline: none;
		border-color: rgb(var(--c1) / 0.65);
		box-shadow: 0 0 0 3px rgb(var(--c1) / 0.15);
	}
	.expanded-help {
		margin: 0;
		font-size: 11.5px;
		color: var(--dim);
	}
	/* While expanded, the dialog grows and stops scrolling so the editor fills it. */
	:global(.fp-body:has(.text-expanded)) {
		overflow: hidden;
	}
	:global(dialog:has(.text-expanded)) {
		width: min(920px, calc(100vw - 32px));
		height: min(760px, 90vh);
		overflow: hidden;
	}
	@keyframes grow {
		from {
			opacity: 0;
			transform: scale(0.985);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.text-expanded {
			animation: none;
		}
	}
</style>
