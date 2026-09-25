<script lang="ts">
	import { untrack } from 'svelte';
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
	/** The version this editor opened; a save is refused if someone else saved after it. */
	const openedVersion = untrack(() => existing?.version);
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

	const newUrl = () =>
		`/api/projects/${project?.id ?? existing?.projectId}/sketches?title=${encodeURIComponent(title)}`;

	async function save(png: Blob) {
		if (onsaved) {
			onsaved(png);
			return onclose();
		}
		saving = true;
		try {
			let asNew = !existing;
			const put = (url: string, method: string) =>
				fetch(url, { method, headers: { 'content-type': 'image/png' }, body: png });
			let r = asNew
				? await put(newUrl(), 'POST')
				: await put(`/api/sketches/${existing!.id}?version=${openedVersion}`, 'PUT');
			// Saved from another device meanwhile: keep both instead of overwriting theirs.
			if (r.status === 409) {
				saving = false;
				if (
					!(await ui.ask(
						'This sketch changed on another device',
						'Someone saved it after you opened it. Save your drawing as a new sketch, so both are kept?',
						'Save as new'
					))
				)
					return;
				saving = true;
				asNew = true;
				r = await put(newUrl(), 'POST');
			}
			const data = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(data.error ?? 'Could not save the sketch.');
			if (!asNew && existing && title.trim() !== existing.title)
				await lab.call('PATCH', `/api/sketches/${existing.id}`, { title });
			if (data.workspace) lab.adopt(data.workspace);
			else void lab.refresh();
			ui.toast(asNew ? 'Sketch saved to the project.' : 'Sketch updated.');
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
