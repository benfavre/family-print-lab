<script lang="ts">
	import { onMount } from 'svelte';
	import { createScene, type Scene } from '$lib/client/scene';
	import type { Category } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import ModelStage from './ModelStage.svelte';

	export type StageContext =
		{ kind: 'home' } | { kind: 'project'; projectId: string } | { kind: 'printer' };
	let {
		focus = null,
		progress = null,
		note,
		context = { kind: 'home' }
	}: {
		focus?: Category | null;
		progress?: number | null;
		note: string;
		context?: StageContext;
	} = $props();
	const { lab, ui } = useApp();

	// ---------- Which real model to show (falls back to the category shapes when there is none) ----------
	/** The version that could not be shown; others still get their chance. */
	let failedVersion = $state<string | null>(null);
	let tourIndex = $state(0);
	let modelLayer = $state({ layer: 0, total: 0 });
	const tour = $derived(context.kind === 'project' ? [] : lab.recentStages());
	$effect(() => {
		if (tour.length < 2) return;
		const timer = setInterval(() => tourIndex++, 10_000);
		return () => clearInterval(timer);
	});
	const source = $derived.by(() => {
		if (context.kind === 'project')
			return { model: lab.stageFor(context.projectId), why: 'project' as const };
		if (context.kind === 'home' && ui.previewProjectId) {
			const hovered = lab.stageFor(ui.previewProjectId);
			if (hovered) return { model: hovered, why: 'hover' as const };
		}
		const printing = lab.printingStage();
		if (printing) return { model: printing, why: 'printing' as const };
		return { model: tour.length ? tour[tourIndex % tour.length] : null, why: 'tour' as const };
	});
	const model = $derived(
		source.model && source.model.versionId !== failedVersion ? source.model : null
	);
	// No model yet? A project's latest sketch is more telling than a stand-in shape.
	const sketch = $derived(
		!model && context.kind === 'project'
			? lab.ws.sketches.find((s) => s.projectId === context.projectId)
			: undefined
	);
	const caption = $derived.by(() => {
		if (!model && sketch) return 'Latest sketch · add a model to see it in 3D';
		if (!model) return note;
		const pct = model.progress === null ? '' : `${Math.round(model.progress * 100)}%`;
		if (model.progress !== null)
			return model.live
				? `Live from the printer · ${pct} of “${model.name}”`
				: `Printing “${model.name}” · ${pct}, estimated from start time`;
		const project = lab.project(model.projectId)?.title ?? '';
		if (source.why === 'hover') return `${project}: “${model.name}” · preview of the print`;
		if (source.why === 'tour') return `Recent: “${model.name}” for ${project} · drag to turn`;
		return `“${model.name}” · preview of the print, layer by layer · drag to turn`;
	});
	let canvas: HTMLCanvasElement;
	let scene: Scene | null = null;
	let supported = $state(true);
	let shape = $state('Twisted vase');
	let layer = $state('000');

	onMount(() => {
		scene = createScene(canvas, (hud) => {
			if (hud.shape) shape = hud.shape;
			if (hud.layer) layer = hud.layer;
			if (hud.lost) supported = false;
		});
		if (!scene) supported = false;
		return () => scene?.destroy();
	});

	// A page can lock the stage to one project's category and progress; otherwise it tours and previews hovered cards.
	$effect(() => {
		if (!scene) return;
		if (focus) scene.focus(focus, progress);
		else scene.release();
	});
	$effect(() => {
		if (scene && !focus && ui.previewCategory) scene.setShape(ui.previewCategory);
	});
	$effect(() => {
		void ui.theme;
		scene?.refreshTheme();
	});
	// The stand-in shapes stop drawing while a real model or sketch covers them.
	$effect(() => {
		scene?.setPaused(!!model || !!sketch);
	});
</script>

<figure
	class="stage"
	class:no-webgl={!supported && !model && !sketch}
	class:has-model={!!model || !!sketch}
>
	<canvas bind:this={canvas} id="scene" aria-hidden="true"></canvas>
	{#if sketch}
		<img
			class="stage-sketch"
			src="/api/sketches/{sketch.id}?v={sketch.version}"
			alt="Sketch of the idea"
		/>
	{/if}
	{#if model}
		<ModelStage
			{model}
			onlayer={(l, t) => (modelLayer = { layer: l, total: t })}
			onfail={() => (failedVersion = model?.versionId ?? null)}
		/>
	{/if}
	<div class="stage-hud" aria-hidden="true">
		<span class="hud-left"
			><span class="hud-label"
				>{model
					? model.progress !== null
						? 'On the printer'
						: 'Your model'
					: sketch
						? 'Your sketch'
						: 'Visualizer'}</span
			><span>{model ? model.name : sketch ? sketch.title || 'Sketch' : shape}</span></span
		>
		<span class="hud-right"
			><span class="hud-label">Layer</span><span
				>{model
					? `${String(modelLayer.layer).padStart(3, '0')}/${String(modelLayer.total).padStart(3, '0')}`
					: sketch
						? '—'
						: layer}</span
			></span
		>
	</div>
	<figcaption class="stage-note">{caption}</figcaption>
</figure>

<style>
	/* The category animation keeps running underneath but is hidden while a real model is shown. */
	.has-model #scene {
		visibility: hidden;
	}
	.stage-sketch {
		position: absolute;
		inset: 44px 16px 36px;
		width: calc(100% - 32px);
		height: calc(100% - 80px);
		object-fit: contain;
		border-radius: 8px;
		background: #f7f4ec;
	}
	.has-model .stage-hud {
		pointer-events: none;
	}
</style>
