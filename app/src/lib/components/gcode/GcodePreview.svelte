<script lang="ts">
	import { onMount } from 'svelte';
	import { GcodeViewer, type GcodeView } from './viewer';
	import { loadPreview } from './load';
	import LayerTimes from './LayerTimes.svelte';
	import {
		FEATURE_COLOURS,
		SPEED_RAMP,
		clock,
		featuresUsed,
		segmentColours,
		speedRange,
		type ColourMode
	} from '$lib/shared/gcode-preview';
	import type { PreviewData } from '$lib/shared/slicer/preview';
	import { weight } from '$lib/client/format';
	import { useApp } from '$lib/client/app.svelte';

	// A sliced plate's toolpaths: layer range and in-layer scrubber, colour by feature, filament or
	// speed, legend toggles, time per layer. `liveLayer` (1-based): the layer the printer is on now.
	let {
		jobId,
		file,
		plate,
		grams = null,
		liveLayer = null,
		compact = false
	}: {
		jobId: string;
		/** The stored sliced file (a new file is a new preview). */
		file: string;
		plate: number;
		grams?: number | null;
		liveLayer?: number | null;
		compact?: boolean;
	} = $props();

	const { lab } = useApp();
	let host: HTMLDivElement;
	let viewer = $state<GcodeViewer | null>(null);
	let failed = $state(false);
	let data = $state.raw<PreviewData | null>(null);
	let status = $state<{
		kind: 'loading' | 'waiting' | 'error' | 'ready';
		message?: string;
		taskId?: string;
	}>({ kind: 'loading' });
	/** Bumped by "Try again". */
	let attempt = $state(0);
	let mode = $state<ColourMode>('feature');
	let hidden = $state<number[]>([]);
	let from = $state(0);
	let to = $state(0);
	let moves = $state(0);
	let solid = $state(false);
	let followed: number | null = null;

	const layers = $derived(data?.header.layers ?? []);
	const last = $derived(Math.max(0, layers.length - 1));
	const top = $derived(layers[to]);
	const used = $derived(data ? featuresUsed(data) : []);
	const speeds = $derived(data ? speedRange(data) : [0, 0]);
	const travel = $derived(data?.header.features.indexOf('Travel') ?? 1);
	/** Nothing is printed on the plate (only travel, if anything): say so over the empty stage. */
	const empty = $derived(!!data && used.every((f) => f.code === travel || f.name === 'Wipe'));
	/** The background task reading a big plate, for its progress. */
	const task = $derived(
		status.kind === 'waiting' ? lab.tasks.find((t) => t.id === status.taskId) : undefined
	);
	const views: [GcodeView, string][] = [
		['iso', 'Iso'],
		['top', 'Top'],
		['front', 'Front']
	];

	onMount(() => {
		try {
			viewer = new GcodeViewer(host);
		} catch {
			failed = true;
		}
		return () => {
			viewer?.dispose();
			viewer = null;
		};
	});

	// Load (again) whenever the file or plate changes.
	$effect(() => {
		void attempt;
		const abort = new AbortController();
		status = { kind: 'loading' };
		data = null;
		loadPreview({ jobId, plate, file, signal: abort.signal }, (taskId) => {
			if (!abort.signal.aborted) status = { kind: 'waiting', taskId };
		}).then(
			(d) => {
				if (abort.signal.aborted) return;
				data = d;
				hidden = [d.header.features.indexOf('Travel')];
				from = 0;
				followed = null;
				showTop(d.header.layers.length - 1, d);
				status = { kind: 'ready' };
			},
			(e: Error) => {
				if (!abort.signal.aborted) status = { kind: 'error', message: e.message };
			}
		);
		return () => abort.abort();
	});

	$effect(() => {
		if (viewer && data) viewer.load(data);
	});
	$effect(() => {
		if (viewer && data) viewer.setColours(segmentColours(data, mode, new Set(hidden)));
	});
	$effect(() => {
		if (viewer && data && layers.length) viewer.setRange(from, to, moves, solid);
	});
	// Follow the printer's layer while printing (until someone moves the slider).
	$effect(() => {
		if (!data || !liveLayer || liveLayer === followed) return;
		if (followed !== null && to !== Math.min(followed - 1, last)) return;
		followed = liveLayer;
		showTop(Math.min(liveLayer - 1, last));
	});

	function showTop(i: number, d = data) {
		const count = d?.header.layers.length ?? 0;
		to = Math.max(0, Math.min(i, count - 1));
		if (from > to) from = to;
		moves = d?.header.layers[to]?.count ?? 0;
	}
	function toggle(code: number) {
		hidden = hidden.includes(code) ? hidden.filter((c) => c !== code) : [...hidden, code];
	}
	const swatch = (name: string) => FEATURE_COLOURS[name] ?? '#888888';
	const ramp = `linear-gradient(90deg, ${SPEED_RAMP.join(', ')})`;
</script>

<div class="gp" class:compact>
	<div class="gp-stage">
		<div class="gp-host" bind:this={host}></div>
		{#if failed}
			<p class="gp-msg">The toolpath preview needs WebGL, which this browser has turned off.</p>
		{:else if status.kind === 'loading'}
			<p class="gp-msg"><span class="spinner"></span>Loading the toolpaths…</p>
		{:else if status.kind === 'waiting'}
			<p class="gp-msg">
				<span class="spinner"></span>{task?.stage ?? 'Reading the toolpaths…'} This is a big plate: you
				can close this and come back.
			</p>
		{:else if status.kind === 'error'}
			<div class="gp-msg bad">
				<p>{status.message}</p>
				<button type="button" class="mini" onclick={() => attempt++}>Try again</button>
			</div>
		{:else if empty}
			<p class="gp-msg quiet">This plate has no printed moves to show.</p>
		{/if}
		{#if data?.header.segments}
			<div class="gp-bar top">
				<div class="seg" role="group" aria-label="Camera view">
					{#each views as [v, label] (v)}
						<button type="button" onclick={() => viewer?.setView(v)}>{label}</button>
					{/each}
				</div>
				{#if liveLayer}<span class="chip-live">● Printing layer {liveLayer}</span>{/if}
			</div>
		{/if}
	</div>

	{#if data?.header.segments && top}
		<div class="gp-controls">
			<label class="gp-slider">
				<span
					>Layer <b>{to + 1}</b> of {layers.length} · {top.z} mm{top.seconds !== null
						? ` · ${clock(top.seconds)}`
						: ''}</span
				>
				<input
					type="range"
					min="0"
					max={last}
					value={to}
					oninput={(e) => showTop(+e.currentTarget.value)}
					aria-label="Top layer shown"
				/>
			</label>
			<label class="gp-slider">
				<span>From layer <b>{from + 1}</b></span>
				<input
					type="range"
					min="0"
					max={to}
					bind:value={from}
					disabled={to === 0}
					aria-label="Lowest layer shown"
				/>
			</label>
			<label class="gp-slider wide">
				<span>Moves in layer {to + 1}: <b>{moves}</b> of {top.count}</span>
				<input
					type="range"
					min="0"
					max={top.count}
					bind:value={moves}
					aria-label="Moves shown in the top layer"
				/>
			</label>
		</div>

		<div class="gp-legend">
			<div class="seg" role="group" aria-label="Colour by">
				<button type="button" aria-pressed={mode === 'feature'} onclick={() => (mode = 'feature')}
					>Feature</button
				>
				<button type="button" aria-pressed={mode === 'filament'} onclick={() => (mode = 'filament')}
					>Filament</button
				>
				<button type="button" aria-pressed={mode === 'speed'} onclick={() => (mode = 'speed')}
					>Speed</button
				>
			</div>
			<label class="check"><input type="checkbox" bind:checked={solid} /> Solid top layer</label>
			<ul class="keys" aria-label="Legend">
				{#if mode === 'feature'}
					{#each used as f (f.code)}
						<li>
							<button
								type="button"
								class="key"
								aria-pressed={!hidden.includes(f.code)}
								title={hidden.includes(f.code) ? `Show ${f.name}` : `Hide ${f.name}`}
								onclick={() => toggle(f.code)}
								><i style:--c={swatch(f.name)}></i>{f.code === travel
									? 'Travel moves'
									: f.name}</button
							>
						</li>
					{/each}
				{:else if mode === 'filament'}
					{#each data.header.tools as t (t.index)}
						<li class="key static">
							<i style:--c={t.color}></i>Filament {t.index + 1}{t.type ? ` · ${t.type}` : ''}
						</li>
					{/each}
					<li>
						<button
							type="button"
							class="key"
							aria-pressed={!hidden.includes(travel)}
							onclick={() => toggle(travel)}
							><i style:--c={swatch('Travel')}></i>Travel moves</button
						>
					</li>
				{:else}
					<li class="key static speed">
						<span>{speeds[0]} mm/s</span><i class="ramp" style:--ramp={ramp}></i><span
							>{speeds[1]} mm/s</span
						>
					</li>
					<li>
						<button
							type="button"
							class="key"
							aria-pressed={!hidden.includes(travel)}
							onclick={() => toggle(travel)}
							><i style:--c={swatch('Travel')}></i>Travel moves</button
						>
					</li>
				{/if}
			</ul>
		</div>

		<p class="gp-totals">
			<span>Total <b>{clock(data.header.totalSeconds)}</b></span>
			{#if grams !== null}<span>Filament <b>{weight(grams)}</b></span>{/if}
			<span>{layers.length} layers</span>
			<span>{data.header.segments.toLocaleString()} moves</span>
		</p>
		{#if data.header.decimated}
			<p class="gp-note">
				This plate is very big, so travel moves are left out{data.header.decimated.joined
					? ` and ${data.header.decimated.joined.toLocaleString()} tiny moves are joined`
					: ''} to keep the preview smooth.
			</p>
		{/if}
		{#if !compact}
			<LayerTimes {layers} {from} {to} onpick={(i) => showTop(i)} />
		{/if}
	{/if}
</div>

<style>
	.gp {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}
	.gp-stage {
		position: relative;
		height: min(58vh, 520px);
		min-height: 280px;
		border-radius: var(--r-lg);
		border: 1px solid var(--line);
		/* A dark stage in every theme: the feature colours are Bambu Studio's, made for dark. */
		background: radial-gradient(120% 90% at 50% 20%, #1a2233, #0d1016 70%);
		overflow: hidden;
		isolation: isolate;
	}
	.compact .gp-stage {
		height: 260px;
		min-height: 0;
	}
	.gp-host {
		position: absolute;
		inset: 0;
	}
	.gp-host :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}
	.gp-msg {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin: 0;
		padding: 20px;
		text-align: center;
		color: #aab6c8;
		font-size: 13px;
	}
	.gp-msg.bad {
		flex-direction: column;
		color: var(--err-text);
	}
	.gp-msg p {
		margin: 0;
	}
	.gp-msg.quiet {
		pointer-events: none;
	}
	.gp-bar {
		position: absolute;
		left: 10px;
		right: 10px;
		top: 10px;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		pointer-events: none;
	}
	.gp-bar > * {
		pointer-events: auto;
	}
	.seg {
		display: inline-flex;
		border-radius: var(--r-sm);
		background: rgb(var(--base) / 0.72);
		backdrop-filter: blur(8px);
		box-shadow: 0 0 0 1px var(--line) inset;
		padding: 2px;
	}
	.seg button {
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
	.chip-live {
		font-size: 12px;
		padding: 4px 9px;
		border-radius: var(--r-sm);
		color: var(--amber);
		background: rgb(var(--base) / 0.72);
		box-shadow: 0 0 0 1px rgb(var(--c4) / 0.45) inset;
	}
	.gp-controls {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px 16px;
	}
	.gp-slider {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.gp-slider.wide {
		grid-column: 1 / -1;
	}
	.gp-slider b {
		color: var(--text);
		font-weight: 550;
	}
	.gp-slider input {
		width: 100%;
		accent-color: var(--cyan);
	}
	.gp-legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-2);
	}
	.keys {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
		flex-basis: 100%;
	}
	.key {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 0;
		border-radius: 999px;
		padding: 4px 10px;
		font-size: 12px;
		background: rgb(var(--hi) / 0.05);
		color: var(--text-2);
		box-shadow: 0 0 0 1px var(--line) inset;
	}
	button.key:hover {
		background: rgb(var(--hi) / 0.09);
		color: var(--text);
	}
	button.key[aria-pressed='false'] {
		color: var(--dim);
		text-decoration: line-through;
	}
	button.key[aria-pressed='false'] i {
		opacity: 0.3;
	}
	.key i {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--c);
		box-shadow: 0 0 0 1px var(--line-strong) inset;
	}
	.key.speed {
		gap: 8px;
		font-variant-numeric: tabular-nums;
	}
	.key i.ramp {
		width: 120px;
		height: 8px;
		border-radius: 4px;
		background: var(--ramp);
	}
	.gp-totals {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.gp-totals b {
		color: var(--text);
		font-weight: 550;
	}
	.gp-note {
		margin: 0;
		padding: 6px 10px;
		border-radius: var(--r-sm);
		font-size: 12px;
		color: var(--text-2);
		background: rgb(var(--c4) / 0.08);
		box-shadow: 0 0 0 1px rgb(var(--c4) / 0.3) inset;
	}
	.spinner {
		width: 11px;
		height: 11px;
		flex-shrink: 0;
		border-radius: 50%;
		border: 2px solid rgb(var(--c1) / 0.25);
		border-top-color: var(--cyan);
		animation: spin 0.8s linear infinite;
	}
	@media (max-width: 700px) {
		.gp-controls {
			grid-template-columns: 1fr;
		}
		.gp-stage {
			height: 50vh;
		}
	}
</style>
