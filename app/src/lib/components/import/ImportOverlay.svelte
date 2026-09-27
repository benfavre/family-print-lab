<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { meshFormat } from '$lib/client/models';
	import { parseModelLink } from '$lib/shared/model-import';
	import AddToDialog from './AddToDialog.svelte';
	import ImportDialog from './ImportDialog.svelte';
	import { importWindows } from './state.svelte';

	// Drop STL/3MF/OBJ files anywhere to add them to a project, or drop or paste a model page link to
	// import it. Drop zones on the page (a project's Models panel, a job card) handle their own drops
	// first; this catches the rest. Not shown in kid mode (global overlays live outside it).
	const { ui } = useApp();
	let dragging = $state(false);
	let hide: ReturnType<typeof setTimeout> | undefined;

	const wanted = (e: DragEvent) => {
		const types = e.dataTransfer?.types ?? [];
		return types.includes('Files') || types.includes('text/uri-list');
	};
	const editable = (el: EventTarget | null) =>
		el instanceof HTMLElement &&
		(el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

	function dragover(e: DragEvent) {
		if (!wanted(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		dragging = true;
		clearTimeout(hide);
		hide = setTimeout(() => (dragging = false), 200);
	}

	function drop(e: DragEvent) {
		dragging = false;
		if (e.defaultPrevented || !wanted(e) || !e.dataTransfer) return;
		e.preventDefault();
		const all = [...e.dataTransfer.files];
		const models = all.filter((f) => meshFormat(f.name));
		if (models.length) return importWindows.addFiles(models);
		if (all.length)
			return ui.toast('Drop STL, 3MF or OBJ files to add them to a project.', 'error');
		const link = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'))
			.split('\n')
			.find((l) => l && !l.startsWith('#'))
			?.trim();
		if (link && parseModelLink(link)) importWindows.openLink(link);
	}

	function paste(e: ClipboardEvent) {
		if (editable(e.target) || document.querySelector('dialog[open]')) return;
		const text = e.clipboardData?.getData('text')?.trim() ?? '';
		if (!parseModelLink(text)) return;
		e.preventDefault();
		importWindows.openLink(text);
	}
</script>

<svelte:window ondragover={dragover} ondrop={drop} onpaste={paste} />

{#if dragging}
	<div class="drop-frame" aria-hidden="true">
		<p>Drop STL, 3MF or OBJ files to add them to a project, or a model link to import it</p>
	</div>
{/if}

{#if importWindows.link !== null}{#key importWindows.link}<ImportDialog />{/key}{/if}
{#if importWindows.files}<AddToDialog />{/if}

<style>
	.drop-frame {
		position: fixed;
		inset: 8px;
		z-index: 90;
		pointer-events: none;
		border: 2px dashed rgb(var(--c1) / 0.7);
		border-radius: 14px;
		background: rgb(var(--c1) / 0.04);
		display: flex;
		align-items: flex-end;
		justify-content: center;
		padding: 24px;
	}
	.drop-frame p {
		margin: 0;
		padding: 8px 14px;
		border-radius: 999px;
		background: var(--menu);
		border: 1px solid var(--line-strong);
		font-size: 13.5px;
		box-shadow: 0 10px 30px rgb(var(--lo) / 0.35);
		text-align: center;
	}
</style>
