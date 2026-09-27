<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { applyBoolean, booleanProblem } from '$lib/client/slicer/boolean';
	import { hasGeometryDetails } from '$lib/client/slicer/geometry-details';
	import { compose } from '$lib/client/slicer/matrix';
	import type { BooleanAnswer, BooleanMode } from '$lib/shared/slicer/boolean';
	let { ws }: { ws: WorkspaceState } = $props();
	const objects = $derived(
		ws.selection.items.flatMap((pick) => ws.project.objects.filter((o) => o.id === pick.objectId))
	);
	const problem = $derived(booleanProblem(objects));
	const details = $derived(objects.some(hasGeometryDetails));
	let mode = $state<BooleanMode>('union');
	let clearDetails = $state(false);
	let working = $state(false);
	let error = $state('');
	let active: AbortController | null = null;
	onDestroy(() => active?.abort());
	$effect(() => {
		void ws.selection;
		return () => active?.abort();
	});
	$effect(() => {
		void objects;
		clearDetails = false;
		error = '';
	});
	async function combine() {
		if (working || problem || (details && !clearDetails)) return;
		const consent = clearDetails;
		const selection = JSON.stringify(ws.selection);
		const operation = new AbortController();
		active = operation;
		const before = ws.project,
			[first, second] = objects;
		const operand = (object: typeof first) => ({
			meshId: object.parts[0].mesh,
			transform: compose(object.parts[0].transform, object.instances[0].transform)
		});
		working = true;
		ws.busy = 'Combining the objects…';
		error = '';
		try {
			const response = await fetch('/api/slicer-ui/meshes/boolean', {
				method: 'POST',
				signal: operation.signal,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ first: operand(first), second: operand(second), mode })
			});
			const answer = await response.json();
			if (!response.ok) throw new Error(answer.error ?? 'The objects could not be combined.');
			if (operation.signal.aborted || JSON.stringify(ws.selection) !== selection) return;
			if (ws.project !== before) throw new Error('The project changed while combining. Try again.');
			ws.change('Combine objects', (draft) => {
				applyBoolean(
					draft,
					first.id,
					second.id,
					[first.parts[0].mesh, second.parts[0].mesh],
					(answer as BooleanAnswer).mesh,
					consent
				);
			});
		} catch (e) {
			if (!operation.signal.aborted) error = (e as Error).message;
		} finally {
			if (active === operation) {
				active = null;
				working = false;
				if (ws.busy === 'Combining the objects…') ws.busy = '';
			}
		}
	}
</script>

<details class="boolean-panel">
	<summary>Combine</summary>
	{#if problem}<p class="hint">{problem}</p>{:else}
		<p class="hint">
			Keep the settings and filament of {objects[0].name}. The result replaces both objects.
		</p>
		<p class="hint">First: {objects[0].name}<br />Second: {objects[1].name}</p>
		<label
			>Operation<select bind:value={mode} disabled={working}>
				<option value="union">Join both objects</option>
				<option value="subtract">Subtract second from first</option>
				<option value="intersect">Keep their overlap</option>
			</select></label
		>
		{#if details}<p class="hint">
				Combining replaces the triangles. Painting, text, layer heights and saved geometry details
				cannot be kept.
			</p>
			<label class="check"
				><input type="checkbox" bind:checked={clearDetails} disabled={working} /> Clear geometry details
				for this combination</label
			>{/if}
		<button
			class="mini"
			disabled={working || !!ws.busy || (details && !clearDetails)}
			onclick={combine}>{working ? 'Combining…' : 'Combine objects'}</button
		>
	{/if}
	{#if error}<p role="alert" class="error">{error}</p>{/if}
</details>

<style>
	.boolean-panel {
		margin-top: 12px;
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
	select {
		width: 100%;
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
