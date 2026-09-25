<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { usePanel } from '$lib/client/panel';

	let {
		id,
		eyebrow,
		title,
		busy,
		error,
		saveLabel,
		onsubmit,
		onclose,
		ondelete,
		children,
		subject = ''
	}: {
		id: string;
		eyebrow: string;
		title: string;
		busy: boolean;
		error: string;
		saveLabel: string;
		onsubmit: () => void;
		onclose: () => void;
		ondelete?: () => void;
		children: Snippet;
		/** What the panel's title bar shows, e.g. the project name as it is typed. */
		subject?: string;
	} = $props();
	// Inside a floating panel the panel shows the title; the form keeps only its fields and actions.
	const panel = usePanel();
	let form = $state<HTMLFormElement>();
	$effect(() => panel?.setTitle(subject.trim() ? `${title} · ${subject.trim()}` : title));
	onMount(() => {
		if (panel)
			form?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea')?.focus();
	});
</script>

<form
	bind:this={form}
	class:in-panel={!!panel}
	onsubmit={(e) => {
		e.preventDefault();
		if (!busy) onsubmit();
	}}
>
	{#if !panel}
		<div class="dialog-top">
			<div>
				<div class="eyebrow">{eyebrow}</div>
				<h2 id="{id}-title">{title}</h2>
			</div>
			<button type="button" class="icon-button" aria-label="Close" disabled={busy} onclick={onclose}
				>×</button
			>
		</div>
	{/if}
	{@render children()}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="dialog-actions">
		{#if ondelete}<button type="button" class="danger" disabled={busy} onclick={ondelete}
				>Delete</button
			>{:else}<span></span>{/if}
		<div>
			<button type="button" class="secondary" disabled={busy} onclick={onclose}>Cancel</button>
			<button type="submit" class="primary" disabled={busy}>{busy ? 'Saving…' : saveLabel}</button>
		</div>
	</div>
</form>
