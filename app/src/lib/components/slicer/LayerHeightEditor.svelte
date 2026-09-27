<script lang="ts">
	import { onDestroy } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { findObject } from '$lib/client/slicer/edit';
	import { layerColour, objectLayerView } from '$lib/client/slicer/layer-view';
	import {
		adaptiveProfile,
		adjustProfile,
		effectiveProfile,
		objectLayers,
		objectTriangles,
		profileProblem,
		roundProfile,
		smoothProfile,
		type LayerEdit
	} from '$lib/client/slicer/layers';
	import type { SceneObject } from '$lib/shared/slicer/project';

	// Variable layer height for one object, as Bambu Studio's layer height editor: the profile as a curve
	// (height up, layer height across), a brush that makes layers thicker, thinner, back to normal or
	// smoother around where you press, and Adaptive, Smooth and Reset for the whole object.
	let { ws, obj }: { ws: WorkspaceState; obj: SceneObject } = $props();
	const { ui } = useApp();

	const W = 240,
		H = 200,
		PAD = 4;
	/** Brush steps while the pointer is held (upstream repeats the edit on a timer too). */
	const STEP_MS = 60;
	const STRENGTH = 0.005;

	let mode = $state<LayerEdit>('increase');
	let band = $state(2);
	let quality = $state(0.5);

	const view = $derived.by(() => {
		void ws.meshVersion;
		return objectLayerView(
			ws.project,
			obj,
			ws.defaults,
			ws.meshSource,
			ws.selection.items[0]?.instanceId
		);
	});
	const params = $derived(view.params);
	const height = $derived(params.objectHeight);
	const stored = $derived(obj.layerHeightProfile);
	const problem = $derived(stored?.length ? profileProblem(stored, params) : null);
	const profile = $derived(effectiveProfile(stored, obj.heightRanges, params));
	const layers = $derived(height > 0 ? objectLayers(params, profile).length : 0);
	const uniformLayers = $derived(
		height > 0 ? objectLayers(params, effectiveProfile(undefined, [], params)).length : 0
	);

	// Chart coordinates: z up the side, layer height across.
	const xOf = (h: number) =>
		PAD +
		((h - params.minLayerHeight) / (params.maxLayerHeight - params.minLayerHeight || 1)) *
			(W - 2 * PAD);
	const yOf = (z: number) => H - PAD - (z / (params.objectHeight || 1)) * (H - 2 * PAD);
	const points = $derived(
		Array.from({ length: profile.length / 2 }, (_, i) =>
			[xOf(profile[2 * i + 1]), yOf(profile[2 * i])].map((v) => v.toFixed(1)).join(',')
		).join(' ')
	);

	function save(next: number[], label: string, merge = false) {
		const id = obj.id;
		ws.change(
			label,
			(d) => {
				findObject(d, id).layerHeightProfile = roundProfile(next);
			},
			merge
		);
	}

	let svg = $state<SVGSVGElement>();
	let pressZ = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let first = true;

	function zAt(e: PointerEvent): number {
		const r = svg!.getBoundingClientRect();
		const y = ((e.clientY - r.top) / (r.height || 1)) * H;
		return Math.min(
			params.objectHeight,
			Math.max(0, ((H - PAD - y) / (H - 2 * PAD)) * params.objectHeight)
		);
	}

	function step() {
		const current = effectiveProfile(obj.layerHeightProfile, obj.heightRanges, params);
		const next = adjustProfile(params, current, pressZ, STRENGTH, band, mode);
		if (next === current) return;
		save(next, 'Change layer heights', !first);
		first = false;
	}

	function down(e: PointerEvent) {
		if (e.button !== 0 || !(height > 0)) return;
		svg?.setPointerCapture(e.pointerId);
		pressZ = zAt(e);
		first = true;
		step();
		clearInterval(timer);
		timer = setInterval(step, STEP_MS);
	}
	function move(e: PointerEvent) {
		if (timer) pressZ = zAt(e);
	}
	function up() {
		clearInterval(timer);
		timer = undefined;
	}
	onDestroy(up);

	function adaptive() {
		const triangles = objectTriangles(obj, ws.meshSource, view.instanceId);
		if (!triangles) return ui.toast('The model is still loading. Try again in a moment.', 'error');
		save(adaptiveProfile(params, triangles, quality), 'Adaptive layer heights');
	}
	function smooth() {
		save(smoothProfile(profile, params), 'Smooth layer heights');
	}
	function reset() {
		const id = obj.id;
		ws.change('Reset layer heights', (d) => {
			delete findObject(d, id).layerHeightProfile;
		});
	}

	const MODES: [LayerEdit, string, string][] = [
		['increase', 'Thicker', 'Faster: thicker layers where you press'],
		['decrease', 'Thinner', 'Finer: thinner layers where you press'],
		['reduce', 'Normal', 'Back towards the layer height'],
		['smooth', 'Smooth', 'Even out changes where you press']
	];
	const mm = (v: number) => `${Math.round(v * 1000) / 1000} mm`;
	const legend = $derived(
		`linear-gradient(90deg, ${[params.minLayerHeight, (params.minLayerHeight + params.maxLayerHeight) / 2, params.maxLayerHeight].map((h) => `rgb(${layerColour(h, params).join(' ')})`).join(', ')})`
	);
</script>

<div class="lh">
	{#if !ws.can('variable_layer_height')}<p class="hint">
			Saved in the file; this slicer leaves it out.
		</p>{/if}
	{#if problem}<p class="hint warn">
			{problem} The slicer ignores them until you change or reset them.
		</p>{/if}
	{#if stored?.length && !problem && obj.heightRanges.length}<p class="hint">
			These layer heights replace the height ranges’ own.
		</p>{/if}
	<div class="chart">
		<svg
			bind:this={svg}
			viewBox="0 0 {W} {H}"
			role="img"
			aria-label="Layer height by height on the object: {layers} layers"
			onpointerdown={down}
			onpointermove={move}
			onpointerup={up}
			onpointercancel={up}
		>
			<rect x="0" y="0" width={W} height={H} class="bg" />
			<line
				x1={xOf(params.layerHeight)}
				x2={xOf(params.layerHeight)}
				y1={PAD}
				y2={H - PAD}
				class="base"
			/>
			<polyline {points} class="curve" />
		</svg>
		<div class="axis">
			<span>{mm(params.minLayerHeight)}</span><span>{mm(params.layerHeight)}</span><span
				>{mm(params.maxLayerHeight)}</span
			>
		</div>
	</div>
	<p class="hint">
		{layers} layers{#if layers !== uniformLayers}
			(even layers: {uniformLayers}){/if}. Press on the curve at a height to change it there.
	</p>
	<label class="overlay-switch">
		<input type="checkbox" bind:checked={ws.layerHeightOverlay} disabled={!!ws.paint} />
		Show layer colours
	</label>
	{#if ws.layerHeightOverlay && !ws.paint}
		<div
			class="legend"
			role="img"
			aria-label="Layer height colours: {mm(params.minLayerHeight)} to {mm(params.maxLayerHeight)}"
		>
			<div class="colour-scale" style:background={legend}></div>
			<div class="axis">
				<span>{mm(params.minLayerHeight)} · finer</span><span
					>{mm(params.maxLayerHeight)} · faster</span
				>
			</div>
		</div>
	{/if}
	{#if view.nozzles.length > 1}<p class="hint">
			Limits include nozzles {view.nozzles.join(' and ')}.
		</p>{/if}
	<div class="seg" role="radiogroup" aria-label="Brush">
		{#each MODES as [m, label, title] (m)}
			<button
				role="radio"
				aria-checked={mode === m}
				class:on={mode === m}
				{title}
				onclick={() => (mode = m)}>{label}</button
			>
		{/each}
	</div>
	<label class="slider"
		>Brush <b>{band} mm</b>
		<input type="range" min="0.5" max="20" step="0.5" bind:value={band} />
	</label>
	<label class="slider"
		>Adaptive <b>{quality < 0.34 ? 'finer' : quality > 0.66 ? 'faster' : 'balanced'}</b>
		<input type="range" min="0" max="1" step="0.05" bind:value={quality} />
	</label>
	<div class="buttons">
		<button
			class="mini"
			onclick={adaptive}
			title="Thin layers on gentle slopes, thick ones on walls">Adaptive</button
		>
		<button class="mini" onclick={smooth}>Smooth</button>
		<button class="mini" disabled={!stored?.length} onclick={reset}>Reset</button>
	</div>
</div>

<style>
	.lh {
		display: grid;
		gap: 8px;
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.warn {
		color: var(--err-text);
	}
	.chart {
		display: grid;
		gap: 2px;
	}
	svg {
		width: 100%;
		height: auto;
		touch-action: none;
		cursor: crosshair;
		border-radius: 8px;
	}
	.bg {
		fill: rgb(var(--hi) / 0.04);
		stroke: var(--line);
	}
	.base {
		stroke: var(--muted);
		stroke-dasharray: 3 3;
		stroke-width: 1;
	}
	.curve {
		fill: none;
		stroke: var(--cyan);
		stroke-width: 2;
		stroke-linejoin: round;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		font-size: 11px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.seg {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.seg button {
		padding: 4px 9px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: none;
		color: var(--text);
		font-size: 12.5px;
		cursor: pointer;
	}
	.seg button.on {
		border-color: var(--cyan);
		color: var(--cyan);
	}
	.slider {
		display: grid;
		gap: 4px;
		font-size: 12.5px;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.overlay-switch {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
	}
	.legend {
		display: grid;
		gap: 4px;
	}
	.colour-scale {
		height: 8px;
		border-radius: 4px;
	}
</style>
