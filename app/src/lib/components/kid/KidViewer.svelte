<script lang="ts">
	import { onMount } from 'svelte';
	import type { ModelViewer } from '$lib/client/viewer';

	let {
		mesh,
		color = null,
		busy = false,
		progress = 1,
		label
	}: {
		mesh: Float32Array | null;
		/** Filament colour to show the part in. */
		color?: string | null;
		busy?: boolean;
		/** How much of the part to show as printed (0–1); null loops a layer-by-layer preview. */
		progress?: number | null;
		label: string;
	} = $props();
	let host: HTMLDivElement;
	let viewer = $state<ModelViewer | null>(null);
	let failed = $state(false);
	let shown: Float32Array | null = null;

	onMount(() => {
		let v: ModelViewer | null = null;
		let gone = false;
		void import('$lib/client/viewer').then(({ ModelViewer }) => {
			if (gone) return;
			try {
				v = new ModelViewer(host);
				v.setShowcase({ rotate: true });
				viewer = v;
			} catch {
				failed = true; // no WebGL: the page still works without the turntable
			}
		});
		return () => {
			gone = true;
			v?.dispose();
		};
	});

	$effect(() => {
		if (!viewer || !mesh || mesh === shown) return;
		viewer.load(mesh, !!shown);
		shown = mesh;
	});
	$effect(() => viewer?.setPartColor(color));
	$effect(() => viewer?.setPrintProgress(progress));
</script>

<div class="kid-viewer" class:busy bind:this={host} role="img" aria-label={label}>
	{#if failed}<span class="kid-viewer-note">The 3D view needs a newer browser.</span>{/if}
	{#if busy}<span class="kid-spinner" aria-hidden="true"></span>{/if}
</div>

<style>
	.kid-viewer {
		position: relative;
		width: 100%;
		aspect-ratio: 4 / 3;
		border-radius: 28px;
		background: radial-gradient(circle at 50% 40%, #ffffff 0, #fdf1e2 70%);
		box-shadow: inset 0 0 0 3px var(--k-line);
		overflow: hidden;
	}
	.kid-viewer :global(canvas) {
		display: block;
		width: 100% !important;
		height: 100% !important;
		transition: opacity 0.2s;
	}
	.kid-viewer.busy :global(canvas) {
		opacity: 0.55;
	}
	.kid-spinner {
		position: absolute;
		inset: 0;
		margin: auto;
		width: 54px;
		height: 54px;
		border-radius: 50%;
		border: 7px solid var(--k-line);
		border-top-color: var(--k-berry);
		animation: spin 0.8s linear infinite;
	}
	.kid-viewer-note {
		position: absolute;
		inset: auto 0 16px;
		text-align: center;
		color: var(--k-muted);
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.kid-spinner {
			animation-duration: 2.4s;
		}
	}
</style>
