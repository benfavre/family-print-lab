<script lang="ts">
	import { onMount } from 'svelte';
	import { SlicerScene } from './scene';
	import type { Vec3 } from '$lib/client/slicer/matrix';
	import { addMeasurePoint } from '$lib/client/slicer/measure';
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { clickPick, pickPart } from '$lib/client/slicer/selection';
	import { PAINT_BLOCKER, PAINT_ENFORCER } from '$lib/shared/slicer/paint';

	// The 3D view of the workspace: every plate, the objects, the gizmo, picking and painting.
	let {
		ws,
		scene = $bindable(null),
		measuring = false,
		measurePoints = $bindable([])
	}: {
		ws: WorkspaceState;
		scene?: SlicerScene | null;
		measuring?: boolean;
		measurePoints?: Vec3[];
	} = $props();
	let host: HTMLDivElement;
	let failed = $state(false);

	onMount(() => {
		try {
			scene = new SlicerScene(host, {
				onMeasure: (point) => (measurePoints = addMeasurePoint(measurePoints, point)),
				onPick: (pick, additive, partId) =>
					ws.select(
						pick && partId && !additive
							? pickPart(ws.project, pick.objectId, partId)
							: clickPick(ws.selection, pick, additive)
					),
				onTransform: (pick, transform, final) => {
					if (final) ws.setTransform(pick, transform, labelFor(ws.gizmo));
					else ws.dragging = { pick, transform };
				},
				onPaint: (hit, first) => ws.paintAt(hit, first),
				onPaintEnd: () => {},
				onFace: (pick, normal) => ws.layOn(pick, normal)
			});
		} catch {
			failed = true;
		}
		return () => {
			scene?.dispose();
			scene = null;
		};
	});

	const labelFor = (g: typeof ws.gizmo) =>
		g === 'rotate' ? 'Rotate' : g === 'scale' ? 'Scale' : 'Move';

	// Meshes as they arrive.
	$effect(() => {
		void ws.meshVersion;
		if (!scene) return;
		for (const [id, positions] of ws.meshes) scene.setMesh(id, positions);
		scene.setProject(ws.project, ws.selection);
	});
	$effect(() => {
		scene?.setBed(ws.bed, ws.project.plates.length, ws.plate);
	});
	$effect(() => {
		scene?.setMeasure(measuring, measurePoints);
	});
	let framed = false;
	$effect(() => {
		// Frame the first plate once the bed is known.
		void ws.bed;
		if (scene && !framed) {
			framed = true;
			scene.focusPlate(ws.plate);
		}
	});
	$effect(() => {
		scene?.setProject(ws.project, ws.selection);
	});
	$effect(() => {
		scene?.setGizmo(
			ws.gizmo,
			ws.snapping ? { move: 1, rotate: 15, scale: 0.05 } : { move: 0, rotate: 0, scale: 0 }
		);
	});
	$effect(() => {
		scene?.setLayFace(ws.layFace);
	});
	$effect(() => {
		const p = ws.paint;
		const obj = ws.selection.items[0]?.objectId;
		if (!scene) return;
		if (!p || !obj) return scene.setPaint(null);
		const colours: Record<number, string> =
			p.kind === 'color'
				? Object.fromEntries(ws.project.filaments.map((f) => [f.index, f.color]))
				: p.kind === 'fuzzySkin'
					? { 1: '#d9a13d' }
					: { [PAINT_ENFORCER]: '#3d8bff', [PAINT_BLOCKER]: '#ff4d6a' };
		scene.setPaint({ kind: p.kind, colours, objectId: obj });
	});

	export function focus(plate: number) {
		scene?.focusPlate(plate);
	}
</script>

<div class="stage-host" bind:this={host}>
	{#if failed}
		<p class="stage-msg">The 3D view needs WebGL, which this browser has turned off.</p>
	{/if}
</div>

<style>
	.stage-host {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 320px;
		overflow: hidden;
		touch-action: none;
	}
	.stage-host :global(.slicer-canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}
	.stage-msg {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--muted);
		font-size: 13px;
	}
</style>
