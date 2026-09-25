<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import {
		BED,
		ModelViewer,
		type Analysis,
		type Measurement,
		type PickMode,
		type View,
		type ViewerEvents
	} from '$lib/client/viewer';
	import { useApp } from '$lib/client/app.svelte';

	let {
		viewer = $bindable(null),
		mode = 'orbit',
		busy = false,
		empty = 'No geometry yet.',
		events = {},
		overhangs = $bindable(false),
		tools
	}: {
		viewer?: ModelViewer | null;
		/** Paint the faces that need support. */
		overhangs?: boolean;
		mode?: PickMode;
		busy?: boolean;
		empty?: string;
		events?: ViewerEvents;
		tools?: Snippet;
	} = $props();
	const { ui } = useApp();
	let host: HTMLDivElement;
	let measurement = $state<Measurement | null>(null);
	let section = $state<number | null>(null);
	let wire = $state(false);
	let analysis = $state<Analysis | null>(null);
	let failed = $state(false);
	let bounds = $state(viewer?.bounds() ?? null);

	onMount(() => {
		try {
			viewer = new ModelViewer(host, {
				...events,
				onMeasure: (m) => {
					measurement = m;
					events.onMeasure?.(m);
				}
			});
		} catch {
			failed = true;
		}
		return () => {
			viewer?.dispose();
			viewer = null;
		};
	});

	$effect(() => viewer?.setMode(mode));
	$effect(() => viewer?.setOverhangs(overhangs));
	// Re-read theme colours when the theme changes.
	$effect(() => {
		void ui.theme;
		viewer?.refreshTheme();
	});

	/** Called by the parent after loading a mesh, so the size readout and section slider follow it. */
	export function refresh() {
		bounds = viewer?.bounds() ?? null;
		analysis = viewer?.analysis() ?? null;
		if (section !== null && bounds)
			section = Math.min(Math.max(section, bounds.min[2]), bounds.max[2]);
	}

	const views: [View, string, string][] = [
		['iso', 'Iso', '1'],
		['top', 'Top', '2'],
		['front', 'Front', '3'],
		['right', 'Side', '4']
	];
	const fits = $derived(
		!bounds || (bounds.size[0] <= BED.x && bounds.size[1] <= BED.y && bounds.size[2] <= BED.z)
	);
	const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

	function key(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
		if ((e.target as HTMLElement).closest('input, textarea, select, .cm-editor, [contenteditable]'))
			return;
		const v = views.find((x) => x[2] === e.key);
		if (v) viewer?.setView(v[0]);
		if (e.key === 'f' || e.key === 'F') viewer?.fit();
	}
</script>

<svelte:window onkeydown={key} />

<div class="viewer" class:busy>
	<div class="viewer-host" bind:this={host} data-mode={mode}></div>
	{#if failed}
		<p class="viewer-empty">3D preview needs WebGL, which this browser has turned off.</p>
	{:else if !bounds && !busy}
		<p class="viewer-empty">{empty}</p>
	{/if}
	<div class="viewer-bar top">
		<div class="seg" role="group" aria-label="Camera view">
			{#each views as [v, label, k] (v)}
				<button type="button" onclick={() => viewer?.setView(v)} title="{label} view ({k})"
					>{label}</button
				>
			{/each}
		</div>
		<div class="seg" role="group" aria-label="Display">
			<button
				type="button"
				aria-pressed={wire}
				onclick={() => viewer?.setWireframe((wire = !wire))}
				title="Show triangles">Wire</button
			>
			<button
				type="button"
				aria-pressed={section !== null}
				disabled={!bounds}
				onclick={() => {
					section = section === null && bounds ? bounds.min[2] + bounds.size[2] / 2 : null;
					viewer?.setSection(section);
				}}
				title="Slice the view to look inside">Section</button
			>
			<button
				type="button"
				aria-pressed={overhangs}
				disabled={!bounds}
				onclick={() => (overhangs = !overhangs)}
				title="Show faces steeper than 45° that need support">Overhangs</button
			>
		</div>
		{@render tools?.()}
	</div>
	{#if section !== null && bounds}
		<label class="viewer-section">
			<span>Z {fmt(section)} mm</span>
			<input
				type="range"
				min={bounds.min[2]}
				max={bounds.max[2]}
				step={Math.max(bounds.size[2] / 400, 0.05)}
				value={section}
				oninput={(e) => viewer?.setSection((section = +e.currentTarget.value))}
				aria-label="Section height"
			/>
		</label>
	{/if}
	<div class="viewer-bar bottom">
		{#if bounds}
			<span
				class="dims size"
				class:bad={!fits}
				title={fits
					? 'Fits the X2D build volume (256 × 256 × 260 mm)'
					: 'Larger than the X2D build volume (256 × 256 × 260 mm)'}
			>
				<b>{fmt(bounds.size[0])}</b> × <b>{fmt(bounds.size[1])}</b> × <b>{fmt(bounds.size[2])}</b>
				mm
				{#if !fits}<em>· too big for the bed</em>{/if}
			</span>
		{/if}
		{#if analysis && bounds}
			<span
				class="dims"
				title="Rough PLA estimate with 2 walls and 15 % infill; the slicer has the real number"
				>≈ <b>{analysis.grams < 10 ? analysis.grams.toFixed(1) : Math.round(analysis.grams)} g</b> PLA</span
			>
		{/if}
		{#if overhangs && analysis}
			{@const share = analysis.area ? analysis.overhangArea / analysis.area : 0}
			<span class="dims" class:warn-chip={share > 0.01}
				>{share > 0.01
					? `Overhangs: ${Math.round(share * 100)} % of the surface — supports or a different orientation`
					: 'No overhangs to support'}</span
			>
		{/if}
		{#if measurement}
			<span class="measure-out"
				>⟷ <b>{measurement.distance.toFixed(2)} mm</b>
				<small>Δ {measurement.delta.map((d) => d.toFixed(1)).join(' / ')}</small></span
			>
		{:else if mode === 'measure'}
			<span class="hint">Click two points on the part to measure.</span>
		{:else if mode === 'face'}
			<span class="hint">Click the face that should sit on the bed.</span>
		{:else if mode === 'point'}
			<span class="hint">Click the spot on the part.</span>
		{/if}
	</div>
	{#if busy}<div class="viewer-busy" aria-live="polite">
			<span class="spinner"></span>Rendering…
		</div>{/if}
</div>

<style>
	.viewer {
		position: relative;
		min-height: 320px;
		height: 100%;
		border-radius: var(--r-lg);
		border: 1px solid var(--line);
		background:
			radial-gradient(120% 90% at 50% 20%, rgb(var(--c1) / 0.07), transparent 60%),
			var(--panel-strong);
		overflow: hidden;
		isolation: isolate;
	}
	.viewer-host {
		position: absolute;
		inset: 0;
	}
	.viewer-host :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}
	.viewer-host[data-mode='measure'] :global(canvas),
	.viewer-host[data-mode='face'] :global(canvas),
	.viewer-host[data-mode='point'] :global(canvas) {
		cursor: crosshair;
	}
	.viewer-empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--dim);
		font-size: 13px;
		pointer-events: none;
	}
	.viewer-bar {
		position: absolute;
		left: 10px;
		right: 10px;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		pointer-events: none;
	}
	.viewer-bar > :global(*) {
		pointer-events: auto;
	}
	.top {
		top: 10px;
	}
	.bottom {
		bottom: 10px;
		font-size: 12px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.seg {
		display: inline-flex;
		border-radius: var(--r-sm);
		background: rgb(var(--base) / 0.72);
		backdrop-filter: blur(8px);
		box-shadow: 0 0 0 1px var(--line) inset;
		padding: 2px;
	}
	.seg button,
	.viewer-bar :global(.seg button) {
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		padding: 4px 9px;
		border-radius: 6px;
	}
	.seg button:hover {
		color: var(--text);
		background: rgb(var(--hi) / 0.06);
	}
	.seg button[aria-pressed='true'] {
		color: var(--on-accent);
		background: var(--cyan);
	}
	.dims,
	.measure-out,
	.hint {
		background: rgb(var(--base) / 0.72);
		backdrop-filter: blur(8px);
		border-radius: var(--r-sm);
		padding: 4px 9px;
		box-shadow: 0 0 0 1px var(--line) inset;
	}
	.dims b,
	.measure-out b {
		color: var(--text);
		font-weight: 550;
	}
	.dims.bad {
		box-shadow: 0 0 0 1px rgb(var(--c5) / 0.6) inset;
	}
	.dims.warn-chip {
		color: var(--err-text);
		box-shadow: 0 0 0 1px rgb(var(--c5) / 0.5) inset;
	}
	.dims em {
		color: var(--err-text);
		font-style: normal;
	}
	.measure-out {
		box-shadow: 0 0 0 1px rgb(var(--c4) / 0.5) inset;
	}
	.measure-out small {
		color: var(--dim);
		margin-left: 6px;
	}
	.hint {
		color: var(--amber);
	}
	.viewer-section {
		position: absolute;
		right: 10px;
		top: 50px;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
		font-size: 11.5px;
		color: var(--amber);
		font-variant-numeric: tabular-nums;
	}
	.viewer-section input {
		writing-mode: vertical-lr;
		direction: rtl;
		height: 180px;
		accent-color: var(--amber);
	}
	.viewer-busy {
		position: absolute;
		top: 10px;
		right: 10px;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--muted);
		background: rgb(var(--base) / 0.72);
		border-radius: var(--r-sm);
		padding: 4px 10px;
	}
	.spinner {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 2px solid rgb(var(--c1) / 0.25);
		border-top-color: var(--cyan);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
</style>
