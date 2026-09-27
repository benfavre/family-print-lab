<script lang="ts">
	import { untrack, onDestroy } from 'svelte';
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { applyCut, cutDetails, cutProblem } from '$lib/client/slicer/cut';
	import { instanceBox } from '$lib/client/slicer/edit';
	import { compose } from '$lib/client/slicer/matrix';
	import type { Instance, SceneObject } from '$lib/shared/slicer/project';
	import type { CutAnswer, CutAxis, CutKeep } from '$lib/shared/slicer/mesh-tools';

	let { ws, object, instance }: { ws: WorkspaceState; object: SceneObject; instance: Instance } =
		$props();
	let axis = $state<CutAxis>('z');
	let at = $state(0);
	let keep = $state<CutKeep>('both');
	let clearDetails = $state(false);
	let working = $state(false);
	let error = $state('');
	let active: AbortController | null = null;
	onDestroy(() => active?.abort());
	$effect(() => {
		void ws.selection;
		return () => active?.abort();
	});
	const problem = $derived(cutProblem(object));
	const details = $derived(cutDetails(object));
	$effect(() => {
		const k = { x: 0, y: 1, z: 2 }[axis];
		const box = instanceBox(ws.project, object, instance.transform, ws.meshSource);
		at = Math.round((box[k] + box[k + 3]) * 50) / 100;
		untrack(() => {
			clearDetails = false;
			error = '';
		});
	});

	async function cut() {
		if (working || problem || (details && !clearDetails)) return;
		const before = ws.project;
		const consent = clearDetails;
		const selection = JSON.stringify(ws.selection);
		const operation = new AbortController();
		active = operation;
		const id = object.id,
			meshId = object.parts[0].mesh;
		working = true;
		ws.busy = 'Cutting the object…';
		error = '';
		try {
			const response = await fetch('/api/slicer-ui/meshes/cut', {
				method: 'POST',
				signal: operation.signal,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					meshId,
					transform: compose(object.parts[0].transform, instance.transform),
					axis,
					at,
					keep
				})
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error ?? 'The object could not be cut.');
			if (operation.signal.aborted || JSON.stringify(ws.selection) !== selection) return;
			if (ws.project !== before) throw new Error('The project changed while cutting. Try again.');
			ws.change('Cut object', (draft) => {
				applyCut(draft, id, meshId, result as CutAnswer, consent);
			});
		} catch (e) {
			if (!operation.signal.aborted) error = (e as Error).message;
		} finally {
			if (active === operation) {
				active = null;
				working = false;
				if (ws.busy === 'Cutting the object…') ws.busy = '';
			}
		}
	}
</script>

<details class="cut-panel">
	<summary>Cut</summary>
	{#if problem}<p class="hint">{problem}</p>{:else}
		<p class="hint">The pieces stay in place. Use Move or Drop to bed afterwards.</p>
		{#if object.instances.length > 1}<p class="hint">Cuts every copy of this object.</p>{/if}
		<div class="fields">
			<label
				>Cut axis<select bind:value={axis} disabled={working}
					><option value="z">Z (height)</option><option value="x">X</option><option value="y"
						>Y</option
					></select
				></label
			>
			<label
				>Cut position (mm)<input
					type="number"
					step="0.1"
					bind:value={at}
					disabled={working}
				/></label
			>
		</div>
		<p class="hint">Position in project coordinates.</p>
		<label
			>Keep<select bind:value={keep} disabled={working}
				><option value="both">Both pieces</option><option value="below">Below the plane</option
				><option value="above">Above the plane</option></select
			></label
		>
		{#if details}
			<p class="hint">
				Cutting replaces the triangles. Painting, text, layer heights and saved geometry details
				cannot be kept.
			</p>
			<label class="check"
				><input type="checkbox" bind:checked={clearDetails} disabled={working} /> Clear geometry details
				for this cut</label
			>
		{/if}
		<button
			class="mini"
			disabled={working || !!ws.busy || !Number.isFinite(at) || (details && !clearDetails)}
			onclick={cut}>{working ? 'Cutting…' : 'Cut object'}</button
		>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</details>

<style>
	.cut-panel {
		margin: 12px 0;
	}
	summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
	}
	.fields {
		display: flex;
		gap: 8px;
	}
	label {
		display: block;
		font-size: 12px;
		margin: 8px 0;
		min-width: 0;
		flex: 1;
	}
	input:not([type='checkbox']),
	select {
		width: 100%;
		min-width: 0;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.error {
		color: var(--err-text);
		font-size: 12px;
	}
</style>
