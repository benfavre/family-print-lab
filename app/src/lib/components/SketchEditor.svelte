<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { usePanel } from '$lib/client/panel';
	import SketchPad from './SketchPad.svelte';

	let {
		projectId = null,
		sketchId = null,
		onsaved,
		onclose
	}: {
		projectId?: string | null;
		sketchId?: string | null;
		/** For ideas not saved yet: the drawing goes back to the form instead of the server. */
		onsaved?: (png: Blob) => void;
		onclose: () => void;
	} = $props();
	const { lab, ui } = useApp();
	const existing = $derived(sketchId ? lab.ws.sketches.find((s) => s.id === sketchId) : undefined);
	const project = $derived(lab.project(projectId ?? existing?.projectId));
	// svelte-ignore state_referenced_locally
	let title = $state(existing?.title ?? '');
	let saving = $state(false);
	// svelte-ignore state_referenced_locally
	const base = existing ? `/api/sketches/${existing.id}?v=${existing.version}` : null;

	const panel = usePanel();
	$effect(() => {
		panel?.setTitle(
			`✎ ${existing ? 'Sketch' : 'New sketch'}${project ? ` · ${project.title}` : ''}`
		);
	});

	async function save(png: Blob) {
		if (onsaved) {
			onsaved(png);
			return onclose();
		}
		saving = true;
		try {
			const url = existing
				? `/api/sketches/${existing.id}`
				: `/api/projects/${project?.id}/sketches?title=${encodeURIComponent(title)}`;
			const r = await fetch(url, {
				method: existing ? 'PUT' : 'POST',
				headers: { 'content-type': 'image/png' },
				body: png
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(data.error ?? 'Could not save the sketch.');
			if (existing && title.trim() !== existing.title)
				await lab.call('PATCH', `/api/sketches/${existing.id}`, { title });
			if (data.workspace) lab.adopt(data.workspace);
			else void lab.refresh();
			ui.toast(existing ? 'Sketch updated.' : 'Sketch saved to the project.');
			onclose();
		} catch (error) {
			ui.toast((error as Error).message, 'error');
		} finally {
			saving = false;
		}
	}
</script>

<div class="sketch-editor">
	{#if !onsaved}
		<label class="field title"
			>Name <input
				bind:value={title}
				maxlength="80"
				placeholder="Optional, e.g. Side view with sizes"
			/></label
		>
	{/if}
	<SketchPad
		{base}
		{saving}
		saveLabel={onsaved ? 'Attach to the idea' : existing ? 'Save changes' : 'Save sketch'}
		onsave={save}
		oncancel={onclose}
	/>
</div>

<style>
	.sketch-editor {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.title {
		margin: 0;
		flex-direction: row;
		align-items: center;
		gap: 10px;
	}
	.title input {
		flex: 1;
	}
</style>
