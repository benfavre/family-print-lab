<script lang="ts" module>
	// Recently shown meshes, so the home tour and hovering do not refetch them.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain cache, never rendered
	const cache = new Map<string, Promise<Float32Array>>();
	function mesh(modelId: string, versionId: string) {
		let hit = cache.get(versionId);
		if (!hit) {
			hit = import('$lib/client/models').then((m) => m.loadMesh(modelId, versionId));
			hit.catch(() => cache.delete(versionId));
			cache.set(versionId, hit);
			if (cache.size > 12) cache.delete(cache.keys().next().value!);
		}
		return hit;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import type { ModelViewer } from '$lib/client/viewer';
	import type { StageModel } from '$lib/client/app.svelte';
	import { useApp } from '$lib/client/app.svelte';

	let {
		model,
		onlayer,
		onfail
	}: {
		model: StageModel;
		onlayer: (layer: number, total: number) => void;
		onfail: () => void;
	} = $props();
	const { ui } = useApp();
	let host: HTMLDivElement;
	let viewer: ModelViewer | null = null;
	let shownVersion = '';
	let visible = $state(false);

	onMount(() => {
		let disposed = false;
		// The 3D library and the mesh are the heaviest things on most pages: load them only once the stage is
		// on screen and the browser is idle, and not at all when the device asks to save data.
		const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
			?.saveData;
		if (saveData) {
			onfail();
			return;
		}
		const whenIdle = (fn: () => void) =>
			'requestIdleCallback' in window
				? requestIdleCallback(fn, { timeout: 1500 })
				: setTimeout(fn, 200);
		const seen = new Promise<void>((resolve) => {
			const io = new IntersectionObserver((entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					io.disconnect();
					resolve();
				}
			});
			io.observe(host);
		});
		void seen
			.then(() => new Promise<void>((r) => whenIdle(() => r())))
			.then(() => import('$lib/client/viewer'))
			.then(({ ModelViewer }) => {
				if (disposed) return;
				try {
					viewer = new ModelViewer(host);
					viewer.setShowcase({
						rotate: !matchMedia('(prefers-reduced-motion: reduce)').matches,
						onLayer: (l, t) => onlayer(l, t)
					});
					void show(model);
				} catch {
					onfail();
				}
			});
		return () => {
			disposed = true;
			viewer?.dispose();
			viewer = null;
		};
	});

	async function show(m: StageModel) {
		if (!viewer || m.versionId === shownVersion) return;
		shownVersion = m.versionId;
		visible = false;
		try {
			const positions = await mesh(m.modelId, m.versionId);
			if (shownVersion !== m.versionId || !viewer) return;
			viewer.load(positions);
			viewer.setPrintProgress(m.progress);
			visible = true;
		} catch {
			onfail();
		}
	}

	$effect(() => {
		const m = model;
		if (viewer) void show(m);
	});
	// Live print progress moves the printed height without reloading the part.
	$effect(() => {
		const p = model.progress;
		if (viewer && model.versionId === shownVersion) viewer.setPrintProgress(p);
	});
	$effect(() => {
		void ui.theme;
		viewer?.refreshTheme();
	});
</script>

<div class="model-stage" class:visible bind:this={host}></div>

<style>
	.model-stage {
		position: absolute;
		inset: 0;
		opacity: 0;
		transition: opacity 0.35s ease;
	}
	.model-stage.visible {
		opacity: 1;
	}
	.model-stage :global(canvas) {
		width: 100%;
		height: 100%;
		display: block;
		cursor: grab;
		touch-action: pan-y;
	}
	.model-stage :global(canvas:active) {
		cursor: grabbing;
	}
</style>
