<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		onclose,
		children,
		id,
		busy = false,
		class: className = ''
	}: {
		onclose: () => void;
		children: Snippet;
		id: string;
		busy?: boolean;
		class?: string;
	} = $props();
	let dialog: HTMLDialogElement;

	$effect(() => {
		dialog.showModal();
		return () => dialog.open && dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	{id}
	class={className}
	aria-labelledby="{id}-title"
	oncancel={(e) => {
		e.preventDefault();
		if (!busy) onclose();
	}}
>
	{@render children()}
</dialog>
