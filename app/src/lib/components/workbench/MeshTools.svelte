<script lang="ts">
	import type { Bounds, ModelViewer, PickMode } from '$lib/client/viewer';
	import type { ModelSummary } from '$lib/shared/domain';
	import { textFrame, textScad, type TextFont } from '$lib/shared/cad';
	import { decodeStl, preview } from '$lib/client/models';

	type Axis = 'x' | 'y' | 'z';
	let {
		bounds,
		viewer,
		mode = $bindable(),
		others,
		busy,
		blender,
		editingInBlender,
		onop,
		onblender
	}: {
		bounds: Bounds | null;
		viewer: ModelViewer | null;
		mode: PickMode;
		others: ModelSummary[];
		busy: boolean;
		blender: boolean;
		editingInBlender: boolean;
		onop: (op: Record<string, unknown>) => Promise<boolean>;
		onblender: (action: 'repair' | 'decimate' | 'open', ratio?: number) => void;
	} = $props();

	let tool = $state<'transform' | 'text' | 'cut' | 'drill' | 'combine' | 'blender'>('transform');
	let copies = $state(4);
	let gap = $state(5);
	let text = $state('');
	let font = $state<TextFont>('bold');
	let letterSize = $state(8);
	let depth = $state(1);
	let textMode = $state<'emboss' | 'engrave'>('emboss');
	let angle = $state(0);
	let place = $state<{ point: [number, number, number]; normal: [number, number, number] } | null>(
		null
	);
	let letters = $state<Float32Array | null>(null);
	let textError = $state('');
	let percent = $state(100);
	let target = $state<[number, number, number]>([0, 0, 0]);
	let lockRatio = $state(true);
	let cutAxis = $state<Axis>('z');
	let cutAt = $state(0);
	let keep = $state<'below' | 'above' | 'both'>('both');
	let drill = $state<{ x: number; y: number } | null>(null);
	let diameter = $state(3.4);
	let otherId = $state('');
	let combineMode = $state<'union' | 'subtract' | 'intersect'>('union');
	let ratio = $state(50);

	const AXES: Axis[] = ['x', 'y', 'z'];
	const idx = { x: 0, y: 1, z: 2 } as const;

	// Keep inputs in step with the current part.
	$effect(() => {
		if (!bounds) return;
		target = [...bounds.size.map((n) => +n.toFixed(1))] as [number, number, number];
	});
	$effect(() => {
		if (!bounds) return;
		const i = idx[cutAxis];
		cutAt = +((bounds.min[i] + bounds.max[i]) / 2).toFixed(2);
	});
	// Previews and pick modes follow the open tool.
	$effect(() => {
		viewer?.setCutPreview(tool === 'cut' && bounds ? { axis: cutAxis, at: cutAt, keep } : null);
		return () => viewer?.setCutPreview(null);
	});
	$effect(() => {
		viewer?.setDrillPreview(tool === 'drill' && drill ? { ...drill, diameter } : null);
		return () => viewer?.setDrillPreview(null);
	});
	// Letters preview: rendered by the same OpenSCAD code the edit uses, placed with the same frame.
	$effect(() => {
		if (tool !== 'text' || !text.trim() || !(letterSize >= 2) || !(depth >= 0.2)) {
			letters = null;
			return;
		}
		const source = textScad(text, font, letterSize, depth, textMode);
		const abort = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const r = await preview(source, {}, abort.signal);
				letters = r.stl ? decodeStl(r.stl) : null;
				textError = r.ok ? '' : 'Those letters could not be made.';
			} catch (error) {
				if ((error as Error).name !== 'AbortError') textError = (error as Error).message;
			}
		}, 250);
		return () => {
			clearTimeout(timer);
			abort.abort();
		};
	});
	$effect(() => {
		viewer?.setGhost(
			tool === 'text' && letters && place ? letters : null,
			place ? textFrame(place.point, place.normal, angle) : undefined
		);
		return () => viewer?.setGhost(null);
	});
	$effect(() => {
		if (tool !== 'drill' && tool !== 'text' && mode === 'point') mode = 'orbit';
		if (tool !== 'transform' && mode === 'face') mode = 'orbit';
	});
	/** Called by the workbench when the user clicks the part in 'point' mode. */
	export function pickPoint(p: [number, number, number], normal: [number, number, number]) {
		if (tool === 'text') place = { point: p, normal };
		else drill = { x: +p[0].toFixed(2), y: +p[1].toFixed(2) };
	}

	function setTarget(axis: number, value: number) {
		if (!bounds || !(value > 0)) return;
		const f = value / bounds.size[axis];
		target = lockRatio
			? (bounds.size.map((n) => +(n * f).toFixed(1)) as [number, number, number])
			: (target.map((n, i) => (i === axis ? value : n)) as [number, number, number]);
	}
	async function scaleToTarget() {
		if (!bounds) return;
		await onop({ op: 'scale', factor: bounds.size.map((n, i) => target[i] / n) });
	}
	async function run(op: Record<string, unknown>) {
		if (await onop(op)) {
			if (op.op === 'drill') drill = null;
			if (op.op === 'text') place = null;
		}
	}
	const fmt = (n: number) => +n.toFixed(2);
</script>

<div class="tools">
	<div class="tool-tabs" role="tablist" aria-label="Mesh tools">
		{#each [['transform', 'Transform'], ['text', 'Text'], ['cut', 'Cut'], ['drill', 'Drill'], ['combine', 'Combine'], ['blender', 'Blender']] as const as [id, label] (id)}
			<button type="button" role="tab" aria-selected={tool === id} onclick={() => (tool = id)}
				>{label}</button
			>
		{/each}
	</div>

	{#if tool === 'transform'}
		<section>
			<h3>Scale</h3>
			<div class="row">
				<input
					class="num"
					type="number"
					min="1"
					max="10000"
					step="1"
					bind:value={percent}
					aria-label="Scale percent"
				/><span class="unit">%</span>
				<button
					class="mini"
					disabled={busy || !percent || percent === 100}
					onclick={() =>
						run({ op: 'scale', factor: [percent / 100, percent / 100, percent / 100] })}
					>Scale evenly</button
				>
			</div>
			<div class="size-grid">
				{#each AXES as a, i (a)}
					<label
						><span>{a.toUpperCase()}</span><input
							class="num"
							type="number"
							min="0.1"
							step="0.1"
							value={target[i]}
							onchange={(e) => setTarget(i, +e.currentTarget.value)}
						/></label
					>
				{/each}
				<span class="unit">mm</span>
			</div>
			<div class="row">
				<label class="check"
					><input type="checkbox" bind:checked={lockRatio} /> Keep proportions</label
				>
				<button
					class="mini"
					disabled={busy || !bounds || target.every((t, i) => Math.abs(t - bounds.size[i]) < 0.051)}
					onclick={scaleToTarget}>Resize to these sizes</button
				>
			</div>
		</section>
		<section>
			<h3>Rotate</h3>
			<div class="btn-grid">
				{#each AXES as a (a)}
					<button
						class="mini"
						disabled={busy}
						onclick={() => run({ op: 'rotate', degrees: AXES.map((x) => (x === a ? 90 : 0)) })}
						>{a.toUpperCase()} +90°</button
					>
					<button
						class="mini"
						disabled={busy}
						onclick={() => run({ op: 'rotate', degrees: AXES.map((x) => (x === a ? -90 : 0)) })}
						>{a.toUpperCase()} −90°</button
					>
				{/each}
			</div>
		</section>
		<section>
			<h3>Place</h3>
			<div class="row wrap">
				<button
					class="mini primary-mini"
					disabled={busy}
					title="Try each flat face as the bottom and keep the one that needs the least support"
					onclick={() => run({ op: 'autoOrient' })}>Auto-orient</button
				>
				<button
					class="mini"
					class:active={mode === 'face'}
					aria-pressed={mode === 'face'}
					disabled={busy}
					onclick={() => (mode = mode === 'face' ? 'orbit' : 'face')}>⤓ Lay flat on face…</button
				>
				<button class="mini" disabled={busy} onclick={() => run({ op: 'center' })}
					>Center on bed</button
				>
			</div>
			<div class="row wrap">
				{#each AXES as a (a)}
					<button class="mini" disabled={busy} onclick={() => run({ op: 'mirror', axis: a })}
						>Mirror {a.toUpperCase()}</button
					>
				{/each}
			</div>
		</section>
		<section>
			<h3>Copies</h3>
			<div class="row">
				<input
					class="num"
					type="number"
					min="2"
					max="36"
					step="1"
					bind:value={copies}
					aria-label="Number of copies"
				/><span class="unit">copies,</span>
				<input
					class="num"
					type="number"
					min="0"
					max="100"
					step="1"
					bind:value={gap}
					aria-label="Gap between copies"
				/><span class="unit">mm apart</span>
			</div>
			<button
				class="mini"
				disabled={busy || !(copies >= 2)}
				onclick={() => run({ op: 'copies', count: copies, gap })}>Lay out on one plate</button
			>
		</section>
	{:else if tool === 'text'}
		<section>
			<p class="help">
				Put a name or label on any face: raised letters, or engraved into the part.
			</p>
			<input
				class="wide-input"
				bind:value={text}
				maxlength="60"
				placeholder="Text, e.g. ALEX"
				aria-label="Text to add"
			/>
			<div class="seg" role="radiogroup" aria-label="Raised or engraved">
				<button
					type="button"
					role="radio"
					aria-checked={textMode === 'emboss'}
					onclick={() => (textMode = 'emboss')}>Raised</button
				>
				<button
					type="button"
					role="radio"
					aria-checked={textMode === 'engrave'}
					onclick={() => (textMode = 'engrave')}>Engraved</button
				>
			</div>
			<div class="seg" role="radiogroup" aria-label="Font">
				{#each [['bold', 'Bold'], ['regular', 'Regular'], ['mono', 'Mono']] as const as [id, label] (id)}
					<button type="button" role="radio" aria-checked={font === id} onclick={() => (font = id)}
						>{label}</button
					>
				{/each}
			</div>
			<div class="row">
				<label class="row"
					><span class="lbl">Height</span><input
						class="num"
						type="number"
						min="2"
						max="200"
						step="0.5"
						bind:value={letterSize}
					/></label
				>
				<label class="row"
					><span class="lbl">Depth</span><input
						class="num"
						type="number"
						min="0.2"
						max="20"
						step="0.2"
						bind:value={depth}
					/></label
				>
				<span class="unit">mm</span>
			</div>
			<button
				class="mini"
				class:active={mode === 'point'}
				aria-pressed={mode === 'point'}
				onclick={() => (mode = mode === 'point' ? 'orbit' : 'point')}
				>⌖ {place ? 'Move' : 'Place'} on the part</button
			>
			{#if place}
				<label class="range"
					><span>Turn <b>{angle}°</b></span><input
						type="range"
						min="-180"
						max="180"
						step="5"
						bind:value={angle}
					/></label
				>
			{/if}
			{#if textError}<p class="help err">{textError}</p>{/if}
			<button
				class="mini primary-mini"
				disabled={busy || !text.trim() || !place}
				onclick={() =>
					place &&
					run({
						op: 'text',
						text,
						font,
						size: letterSize,
						depth,
						mode: textMode,
						point: place.point,
						normal: place.normal,
						angle
					})}>{textMode === 'emboss' ? 'Add raised text' : 'Engrave text'}</button
			>
			<p class="help small">At least 5 mm tall and 0.6 mm deep reads well with a 0.4 mm nozzle.</p>
		</section>
	{:else if tool === 'cut'}
		<section>
			<p class="help">
				Split the part with a flat plane. Keep one side (to remove a base, say), or both pieces,
				each laid flat on one plate — the easy way to print a tall part in two halves without
				supports.
			</p>
			<div class="seg" role="radiogroup" aria-label="Cut direction">
				{#each AXES as a (a)}<button
						type="button"
						role="radio"
						aria-checked={cutAxis === a}
						onclick={() => (cutAxis = a)}>{a.toUpperCase()}</button
					>{/each}
			</div>
			{#if bounds}
				{@const i = idx[cutAxis]}
				<label class="range">
					<span>At {cutAxis.toUpperCase()} = <b>{fmt(cutAt)}</b> mm</span>
					<input
						type="range"
						min={bounds.min[i]}
						max={bounds.max[i]}
						step={Math.max(bounds.size[i] / 500, 0.05)}
						bind:value={cutAt}
					/>
				</label>
			{/if}
			<div class="seg" role="radiogroup" aria-label="Side to keep">
				<button
					type="button"
					role="radio"
					aria-checked={keep === 'below'}
					onclick={() => (keep = 'below')}>Keep {cutAxis === 'z' ? 'below' : 'lower side'}</button
				>
				<button
					type="button"
					role="radio"
					aria-checked={keep === 'above'}
					onclick={() => (keep = 'above')}>Keep {cutAxis === 'z' ? 'above' : 'upper side'}</button
				>
				<button
					type="button"
					role="radio"
					aria-checked={keep === 'both'}
					onclick={() => (keep = 'both')}>Both, flat</button
				>
			</div>
			<button
				class="mini primary-mini"
				disabled={busy || !bounds}
				onclick={() => run({ op: 'cut', axis: cutAxis, at: cutAt, keep })}>Cut</button
			>
		</section>
	{:else if tool === 'drill'}
		<section>
			<p class="help">
				Drill a straight hole down through the part (along Z). 3.4 mm fits an M3 screw, 4.5 mm an
				M4.
			</p>
			<div class="row">
				<button
					class="mini"
					class:active={mode === 'point'}
					aria-pressed={mode === 'point'}
					onclick={() => (mode = mode === 'point' ? 'orbit' : 'point')}>⌖ Pick position</button
				>
				{#if drill}<span class="coords">X {drill.x} · Y {drill.y}</span>{/if}
			</div>
			<label class="row"
				><span class="lbl">Diameter</span><input
					class="num"
					type="number"
					min="0.1"
					max="500"
					step="0.1"
					bind:value={diameter}
				/><span class="unit">mm</span></label
			>
			<button
				class="mini primary-mini"
				disabled={busy || !drill || !(diameter > 0)}
				onclick={() => drill && run({ op: 'drill', x: drill.x, y: drill.y, diameter })}
				>Drill hole</button
			>
		</section>
	{:else if tool === 'combine'}
		<section>
			{#if !others.length}
				<p class="help">
					Add another model to this project to join, subtract or intersect it with this one.
				</p>
			{:else}
				<p class="help">Uses the other model's current version, in its own coordinates.</p>
				<select bind:value={otherId} aria-label="Other model">
					<option value="" disabled>Choose a model…</option>
					{#each others as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
				</select>
				<div class="seg" role="radiogroup" aria-label="How to combine">
					<button
						type="button"
						role="radio"
						aria-checked={combineMode === 'union'}
						onclick={() => (combineMode = 'union')}>Join</button
					>
					<button
						type="button"
						role="radio"
						aria-checked={combineMode === 'subtract'}
						onclick={() => (combineMode = 'subtract')}>Subtract</button
					>
					<button
						type="button"
						role="radio"
						aria-checked={combineMode === 'intersect'}
						onclick={() => (combineMode = 'intersect')}>Intersect</button
					>
				</div>
				<button
					class="mini primary-mini"
					disabled={busy || !otherId}
					onclick={() => run({ op: 'combine', mode: combineMode, otherModelId: otherId })}
					>Combine</button
				>
			{/if}
		</section>
	{:else}
		<section>
			{#if !blender}
				<p class="help">
					Blender was not found. Install it (or set <code>BLENDER_PATH</code> in <code>.env</code>)
					and restart the app.
				</p>
			{:else}
				<h3>Repair</h3>
				<p class="help">
					Merges duplicate points, removes loose bits and fills holes so the part slices cleanly.
				</p>
				<button class="mini" disabled={busy} onclick={() => onblender('repair')}>Repair mesh</button
				>
				<h3>Simplify</h3>
				<label class="range"
					><span>Keep <b>{ratio}%</b> of the triangles</span><input
						type="range"
						min="5"
						max="95"
						step="5"
						bind:value={ratio}
					/></label
				>
				<button class="mini" disabled={busy} onclick={() => onblender('decimate', ratio / 100)}
					>Simplify</button
				>
				<h3>Sculpt and model</h3>
				<p class="help">
					Opens this model in Blender. Each time you save there (Ctrl+S), the lab imports it as a
					new version.
				</p>
				{#if editingInBlender}
					<p class="live"><span class="dot"></span>Open in Blender — save there to update</p>
				{:else}
					<button class="mini" disabled={busy} onclick={() => onblender('open')}
						>Open in Blender</button
					>
				{/if}
			{/if}
		</section>
	{/if}
</div>

<style>
	.tools {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.tool-tabs {
		display: flex;
		gap: 2px;
		padding: 2px;
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
	}
	.tool-tabs button {
		flex: 1;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		padding: 5px 4px;
	}
	.tool-tabs button[aria-selected='true'] {
		background: rgb(var(--hi) / 0.09);
		color: var(--text);
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 9px;
		align-items: flex-start;
	}
	h3 {
		margin: 4px 0 0;
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--dim);
		font-family: var(--mono);
		font-weight: 500;
	}
	.help {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
		line-height: 1.5;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.row.wrap {
		flex-wrap: wrap;
	}
	.num,
	select {
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.03);
		padding: 5px 8px;
		font: 400 12.5px var(--mono);
		color: var(--text);
		width: 84px;
		font-variant-numeric: tabular-nums;
	}
	select {
		width: 100%;
		font-family: var(--sans);
	}
	select option {
		background: var(--menu);
	}
	.wide-input {
		width: 100%;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.03);
		padding: 6px 9px;
		font: 500 13px var(--sans);
		color: var(--text);
	}
	.help.small {
		font-size: 11.5px;
		color: var(--dim);
	}
	.help.err {
		color: var(--err-text);
	}
	.unit,
	.lbl,
	.coords {
		font-size: 12px;
		color: var(--muted);
	}
	.coords {
		font-family: var(--mono);
		color: var(--amber);
	}
	.size-grid {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.size-grid label {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.size-grid label span {
		font: 500 11px var(--mono);
		color: var(--dim);
	}
	.size-grid .num {
		width: 72px;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--muted);
	}
	.check input {
		accent-color: var(--cyan);
	}
	.btn-grid {
		display: grid;
		grid-template-columns: repeat(3, auto);
		grid-auto-flow: column;
		grid-template-rows: auto auto;
		gap: 6px;
	}
	.mini.active {
		background: rgb(var(--c4) / 0.16);
		box-shadow: 0 0 0 1px rgb(var(--c4) / 0.6) inset;
	}
	.seg {
		display: inline-flex;
		border-radius: var(--r-sm);
		padding: 2px;
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
	}
	.seg button {
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		padding: 4px 10px;
		border-radius: 6px;
	}
	.seg button[aria-checked='true'] {
		background: rgb(var(--c1) / 0.16);
		color: var(--text);
		box-shadow: 0 0 0 1px rgb(var(--c1) / 0.45) inset;
	}
	.range {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		font-size: 12px;
		color: var(--muted);
	}
	.range b {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.range input {
		width: 100%;
		accent-color: var(--amber);
	}
	.live {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 12.5px;
		color: var(--lime);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--lime);
		box-shadow: 0 0 10px var(--lime);
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	code {
		font-size: 11.5px;
	}
</style>
