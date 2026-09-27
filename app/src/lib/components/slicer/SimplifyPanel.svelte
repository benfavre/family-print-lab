<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import type { SceneObject } from '$lib/shared/slicer/project';
	import { simplifyObject, simplifyProblem } from '$lib/client/slicer/simplify';
	import { hasGeometryDetails } from '$lib/client/slicer/geometry-details';

	let { ws, object }: { ws: WorkspaceState; object: SceneObject } = $props();
	let tolerance = $state(0.1);
	let clearDetails = $state(false);
	let working = $state(false);
	let error = $state('');
	let report = $state('');
	let controller: AbortController | null = null;
	let shownId: string | null = null;
	const problem = $derived(simplifyProblem(object));
	const details = $derived(hasGeometryDetails(object));
	const triangles = $derived(ws.project.meshes[object.parts[0]?.mesh]?.triangles ?? 0);
	$effect(() => {
		const id = object.id;
		if (id === shownId) return;
		shownId = id;
		untrack(() => {
			controller?.abort();
			clearDetails = false;
			error = report = '';
		});
	});
	onDestroy(() => controller?.abort());

	async function simplify() {
		if (working || ws.busy || problem || (details && !clearDetails)) return;
		controller = new AbortController();
		const signal = controller.signal;
		working = true;
		ws.busy = 'Simplifying the object…';
		error = report = '';
		try {
			const answer = await simplifyObject(ws, object.id, tolerance, clearDetails, signal);
			report =
				answer.after < answer.before
					? `${answer.before.toLocaleString()} → ${answer.after.toLocaleString()} triangles.`
					: 'No triangles could be removed within this limit.';
		} catch (e) {
			if (!signal.aborted) error = (e as Error).message;
		} finally {
			working = false;
			if (ws.busy === 'Simplifying the object…') ws.busy = '';
		}
	}
</script>

<details class="simplify-panel">
	<summary>Simplify</summary>
	{#if problem}
		<p class="hint">{problem}</p>
	{:else}
		<p class="hint">{triangles.toLocaleString()} triangles. Keeps the object in place.</p>
		{#if object.instances.length > 1}<p class="hint">Simplifies every copy of this object.</p>{/if}
		<label
			>Maximum surface change (mm)<input
				type="number"
				min="0.001"
				max="5"
				step="0.01"
				bind:value={tolerance}
				disabled={working}
			/></label
		>
		<p class="hint">
			A smaller limit keeps more detail. Sealed meshes only; repair open meshes in the model
			workbench first.
		</p>
		{#if details}
			<p class="hint">
				Simplifying replaces the triangles. Painting, text, layer heights and saved geometry details
				cannot be kept.
			</p>
			<label class="check"
				><input type="checkbox" bind:checked={clearDetails} disabled={working} /> Clear geometry details
				for this simplification</label
			>
		{/if}
		<button
			class="mini"
			disabled={working ||
				!!ws.busy ||
				!Number.isFinite(tolerance) ||
				tolerance < 0.001 ||
				tolerance > 5 ||
				(details && !clearDetails)}
			onclick={simplify}>{working ? 'Simplifying…' : 'Simplify object'}</button
		>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if report}<p class="hint" role="status">{report}</p>{/if}
</details>

<style>
	.simplify-panel {
		margin: 12px 0;
	}
	summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
	}
	label {
		display: block;
		font-size: 12px;
		margin: 8px 0;
	}
	input[type='number'] {
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
