<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';
	import Stage3D, { type StageContext } from './Stage3D.svelte';
	import type { Category } from '$lib/shared/domain';

	let {
		eyebrow,
		title,
		text = '',
		crumb = false,
		actions,
		extra,
		focus = null,
		progress = null,
		note,
		context = { kind: 'home' },
		onrename
	}: {
		eyebrow: string;
		title: string;
		text?: string;
		crumb?: boolean;
		actions?: Snippet;
		extra?: Snippet;
		focus?: Category | null;
		progress?: number | null;
		note: string;
		context?: StageContext;
		/** When set, the title can be edited in place. */
		onrename?: (title: string) => void;
	} = $props();
	let editing = $state(false);
	let draft = $state('');
	let input = $state<HTMLInputElement>();
	async function edit() {
		draft = title;
		editing = true;
		await tick();
		input?.select();
	}
	function finish(save: boolean) {
		if (!editing) return;
		editing = false;
		if (save && draft.trim() && draft.trim() !== title) onrename?.(draft.trim());
	}
</script>

<section class="hero">
	<div class="hero-copy">
		{#if crumb}<a class="crumb" href={resolve('/')}
				><span aria-hidden="true">←</span> All projects</a
			>{/if}
		<div class="eyebrow">{eyebrow}</div>
		{#if onrename && editing}
			<h1 class="title-edit">
				<span class="sr-only">{title}</span>
				<input
					bind:this={input}
					bind:value={draft}
					maxlength="80"
					aria-label="Project name"
					onkeydown={(e) => {
						if (e.key === 'Enter') finish(true);
						if (e.key === 'Escape') finish(false);
					}}
					onblur={() => finish(true)}
				/>
			</h1>
		{:else if onrename}
			<h1>
				<button class="title-button" title="Rename (click)" onclick={edit}
					>{title}<span class="pencil" aria-hidden="true">✎</span></button
				>
			</h1>
		{:else}
			<h1>{title}</h1>
		{/if}
		{#if text}<p>{text}</p>{/if}
		{#if actions}<div class="hero-actions">{@render actions()}</div>{/if}
		{@render extra?.()}
	</div>
	<Stage3D {focus} {progress} {note} {context} />
</section>

<style>
	.title-button {
		all: unset;
		cursor: text;
		border-radius: 8px;
		transition: background 0.15s;
	}
	.title-button:hover {
		background: rgb(var(--hi) / 0.04);
	}
	.title-button:focus-visible {
		outline: 2px solid var(--cyan);
		outline-offset: 2px;
	}
	.pencil {
		margin-left: 10px;
		font-size: 0.45em;
		color: var(--dim);
		opacity: 0;
		vertical-align: middle;
		transition: opacity 0.15s;
	}
	.title-button:hover .pencil,
	.title-button:focus-visible .pencil {
		opacity: 1;
	}
	.title-edit input {
		all: unset;
		width: 100%;
		border-bottom: 2px solid var(--cyan);
		font: inherit;
		letter-spacing: inherit;
	}
</style>
