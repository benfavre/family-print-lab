<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { hasGeometryDetails } from '$lib/client/slicer/geometry-details';
	import { applyText } from '$lib/client/slicer/text';
	import { instanceBox } from '$lib/client/slicer/edit';
	import { compose } from '$lib/client/slicer/matrix';
	import type { Instance, SceneObject, MeshRef } from '$lib/shared/slicer/project';
	import type { TextFont } from '$lib/shared/cad';
	let { ws, object, instance }: { ws: WorkspaceState; object: SceneObject; instance: Instance } =
		$props();
	let text = $state('');
	let font = $state<TextFont>('bold');
	let size = $state(8),
		depth = $state(1),
		angle = $state(0);
	let mode = $state<'emboss' | 'engrave'>('emboss');
	let clearDetails = $state(false),
		working = $state(false),
		error = $state('');
	let active: AbortController | null = null;
	const supported = $derived(object.parts.length === 1 && object.parts[0].type === 'model');
	const details = $derived(hasGeometryDetails(object));
	const placement = $derived(
		ws.textPlacement?.objectId === object.id && ws.textPlacement.instanceId === instance.id
			? ws.textPlacement
			: null
	);
	const picking = $derived(
		ws.textTarget?.objectId === object.id && ws.textTarget.instanceId === instance.id
	);
	onDestroy(() => {
		active?.abort();
		ws.textTarget = null;
	});
	$effect(() => {
		void ws.selection;
		return () => {
			active?.abort();
			ws.textTarget = null;
		};
	});
	$effect(() => {
		void ws.project;
		untrack(() => {
			ws.textPlacement = null;
			ws.textTarget = null;
			clearDetails = false;
		});
	});
	function pickFace() {
		ws.paint = null;
		ws.layFace = false;
		ws.textTarget = picking ? null : { objectId: object.id, instanceId: instance.id };
	}
	function topCentre() {
		const b = instanceBox(ws.project, object, instance.transform, ws.meshSource);
		ws.textTarget = null;
		ws.textPlacement = {
			objectId: object.id,
			instanceId: instance.id,
			partId: object.parts[0].id,
			point: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, b[5]],
			normal: [0, 0, 1]
		};
	}
	function coordinate(kind: 'point' | 'normal', axis: number, value: number) {
		if (!placement || !Number.isFinite(value)) return;
		const next = { ...placement, [kind]: [...placement[kind]] };
		next[kind][axis] = value;
		ws.textPlacement = next;
	}
	async function apply() {
		if (!supported || !placement || working || (details && !clearDetails)) return;
		const before = ws.project,
			selection = JSON.stringify(ws.selection),
			consent = clearDetails;
		const objectId = object.id,
			sourceMesh = object.parts[0].mesh;
		const operation = new AbortController();
		active = operation;
		working = true;
		ws.busy = 'Making the text…';
		error = '';
		try {
			const response = await fetch('/api/slicer-ui/meshes/text', {
				method: 'POST',
				signal: operation.signal,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					meshId: sourceMesh,
					transform: compose(object.parts[0].transform, instance.transform),
					text,
					font,
					size,
					depth,
					mode,
					point: placement.point,
					normal: placement.normal,
					angle
				})
			});
			const answer = await response.json();
			if (!response.ok) throw new Error(answer.error ?? 'The text could not be made.');
			if (operation.signal.aborted || JSON.stringify(ws.selection) !== selection) return;
			if (ws.project !== before)
				throw new Error('The project changed while making text. Try again.');
			ws.change(mode === 'emboss' ? 'Add raised text' : 'Engrave text', (draft) => {
				applyText(draft, objectId, sourceMesh, answer.mesh as MeshRef, consent);
			});
		} catch (e) {
			if (!operation.signal.aborted) error = (e as Error).message;
		} finally {
			if (active === operation) {
				active = null;
				working = false;
				if (ws.busy === 'Making the text…') ws.busy = '';
			}
		}
	}
</script>

<details class="text-panel">
	<summary>Text</summary>
	{#if !supported}<p class="hint">
			Text supports objects with one model part. Separate parts and modifiers first.
		</p>{:else}
		<label>Text to add<input maxlength="60" bind:value={text} disabled={working} /></label>
		<div class="fields">
			<label
				>Text style<select bind:value={font} disabled={working}
					><option value="bold">Bold</option><option value="regular">Regular</option><option
						value="mono">Monospace</option
					></select
				></label
			>
			<label
				>Text mode<select bind:value={mode} disabled={working}
					><option value="emboss">Raised</option><option value="engrave">Engraved</option></select
				></label
			>
		</div>
		<div class="fields">
			<label
				>Text size (mm)<input
					type="number"
					min="2"
					max="200"
					step="0.5"
					bind:value={size}
					disabled={working}
				/></label
			><label
				>Text depth (mm)<input
					type="number"
					min="0.2"
					max="20"
					step="0.1"
					bind:value={depth}
					disabled={working}
				/></label
			>
		</div>
		<label
			>Text angle (°)<input
				type="number"
				min="-360"
				max="360"
				step="5"
				bind:value={angle}
				disabled={working}
			/></label
		>
		<div class="buttons">
			<button class="mini" aria-pressed={picking} disabled={working} onclick={pickFace}
				>{picking ? 'Cancel face pick' : 'Pick text face'}</button
			><button class="mini" disabled={working} onclick={topCentre}>Use top centre</button>
		</div>
		{#if picking}<p class="hint" role="status">
				Click a face on the selected object. Escape cancels.
			</p>{/if}
		{#if placement}
			<p class="hint">Position and direction in project coordinates.</p>
			{#each ['point', 'normal'] as const as kind (kind)}<div class="fields">
					{#each ['X', 'Y', 'Z'] as axis, k (axis)}<label
							>{kind === 'point' ? 'Position' : 'Direction'}
							{axis}<input
								type="number"
								step="0.1"
								aria-label={`Text ${kind === 'point' ? 'position' : 'direction'} ${axis}`}
								value={placement[kind][k]}
								onchange={(e) => coordinate(kind, k, e.currentTarget.valueAsNumber)}
								disabled={working}
							/></label
						>{/each}
				</div>{/each}
		{:else}<p class="hint">Choose where the text goes.</p>{/if}
		<p class="hint">Text becomes part of the mesh. Undo restores the original.</p>
		{#if object.instances.length > 1}<p class="hint">Changes every copy of this object.</p>{/if}
		{#if details}<p class="hint">
				Adding text replaces the triangles. Painting, existing text, layer heights and saved
				geometry details cannot be kept.
			</p>
			<label class="check"
				><input type="checkbox" bind:checked={clearDetails} disabled={working} /> Clear geometry details
				for this text</label
			>{/if}
		<button
			class="mini"
			disabled={working || !!ws.busy || !text.trim() || !placement || (details && !clearDetails)}
			onclick={apply}
			>{working ? 'Making text…' : mode === 'emboss' ? 'Add raised text' : 'Engrave text'}</button
		>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</details>

<style>
	.text-panel {
		margin-top: 12px;
	}
	summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
	}
	.fields,
	.buttons {
		display: flex;
		gap: 6px;
	}
	label {
		display: block;
		min-width: 0;
		flex: 1;
		font-size: 12px;
		margin: 8px 0;
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
