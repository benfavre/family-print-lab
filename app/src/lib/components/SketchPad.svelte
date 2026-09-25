<script lang="ts">
	import { onMount } from 'svelte';

	// A sketchbook page: draw on paper with pen, marker, straight lines and an eraser; undo/redo; the grid
	// helps with proportions and is not saved. Strokes are kept as vectors, so undo redraws exactly.
	let {
		base = null,
		saving = false,
		saveLabel = 'Save sketch',
		onsave,
		oncancel
	}: {
		/** An existing sketch to draw over. */
		base?: string | null;
		saving?: boolean;
		saveLabel?: string;
		onsave: (png: Blob) => void;
		oncancel?: () => void;
	} = $props();

	const W = 1200,
		H = 900,
		PAPER = '#f7f4ec';
	const INKS = [
		['#1d2330', 'Ink'],
		['#2463eb', 'Blue'],
		['#e2483d', 'Red'],
		['#1f9d55', 'Green'],
		['#f08a24', 'Orange'],
		['#7c4ddb', 'Purple']
	] as const;
	type Tool = 'pen' | 'marker' | 'line' | 'eraser';
	interface Stroke {
		tool: Tool;
		color: string;
		size: number;
		points: [number, number, number][];
	}

	let canvas: HTMLCanvasElement;
	let ctx: CanvasRenderingContext2D;
	let baseImage = $state<HTMLImageElement | null>(null);
	let strokes = $state<Stroke[]>([]);
	let undone = $state<Stroke[]>([]);
	let tool = $state<Tool>('pen');
	let color = $state<string>(INKS[0][0]);
	let size = $state(4);
	let grid = $state(true);
	let current: Stroke | null = null;

	onMount(() => {
		ctx = canvas.getContext('2d')!;
		if (base) {
			const img = new Image();
			img.onload = () => {
				baseImage = img;
				redraw();
			};
			img.src = base;
		}
		redraw();
	});

	function widthOf(s: Stroke, pressure: number) {
		const scale = s.tool === 'marker' ? 3.2 : s.tool === 'eraser' ? 4 : 1;
		return Math.max(1, s.size * scale * (0.55 + pressure * 0.9));
	}

	function paint(s: Stroke) {
		ctx.save();
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.strokeStyle = s.tool === 'eraser' ? PAPER : s.color;
		ctx.globalAlpha = s.tool === 'marker' ? 0.35 : 1;
		const pts = s.points;
		if (s.tool === 'line' || pts.length < 3) {
			ctx.lineWidth = widthOf(s, pts[0]?.[2] ?? 0.5);
			ctx.beginPath();
			ctx.moveTo(pts[0][0], pts[0][1]);
			const last = pts.at(-1)!;
			ctx.lineTo(last[0] + 0.01, last[1]);
			ctx.stroke();
		} else if (s.tool === 'marker') {
			// One path, so overlapping segments do not darken the translucent marker.
			ctx.lineWidth = widthOf(s, 0.5);
			ctx.beginPath();
			ctx.moveTo(pts[0][0], pts[0][1]);
			for (let i = 1; i < pts.length - 1; i++) {
				const mx = (pts[i][0] + pts[i + 1][0]) / 2,
					my = (pts[i][1] + pts[i + 1][1]) / 2;
				ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
			}
			ctx.stroke();
		} else {
			// Smooth curves through the midpoints; width follows pen pressure.
			for (let i = 1; i < pts.length - 1; i++) {
				const [x0, y0] =
					i === 1 ? pts[0] : [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
				const mx = (pts[i][0] + pts[i + 1][0]) / 2,
					my = (pts[i][1] + pts[i + 1][1]) / 2;
				ctx.lineWidth = widthOf(s, pts[i][2]);
				ctx.beginPath();
				ctx.moveTo(x0, y0);
				ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
				ctx.stroke();
			}
			// The curves end at the last midpoint; finish the stroke at the pen's last position.
			const [a, b] = [pts.at(-2)!, pts.at(-1)!];
			ctx.lineWidth = widthOf(s, b[2]);
			ctx.beginPath();
			ctx.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
			ctx.lineTo(b[0], b[1]);
			ctx.stroke();
		}
		ctx.restore();
	}

	function redraw(withGrid = grid) {
		if (!ctx) return;
		ctx.fillStyle = PAPER;
		ctx.fillRect(0, 0, W, H);
		if (baseImage) ctx.drawImage(baseImage, 0, 0, W, H);
		if (withGrid) {
			ctx.save();
			ctx.strokeStyle = 'rgba(40, 70, 120, 0.12)';
			ctx.lineWidth = 1;
			for (let x = 50; x < W; x += 50) {
				ctx.beginPath();
				ctx.moveTo(x, 0);
				ctx.lineTo(x, H);
				ctx.stroke();
			}
			for (let y = 50; y < H; y += 50) {
				ctx.beginPath();
				ctx.moveTo(0, y);
				ctx.lineTo(W, y);
				ctx.stroke();
			}
			ctx.restore();
		}
		for (const s of strokes) paint(s);
		if (current) paint(current);
	}
	$effect(() => {
		void grid;
		redraw();
	});

	function point(e: PointerEvent): [number, number, number] {
		const r = canvas.getBoundingClientRect();
		const pressure = e.pointerType === 'mouse' || !e.pressure ? 0.5 : e.pressure;
		return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H, pressure];
	}
	// Palm rejection: once a stylus has drawn, fingers are ignored; a second finger cancels the
	// stroke it interrupts, and a quick two-finger tap undoes like most drawing apps.
	let activeId: number | null = null;
	let penSeen = false;
	const touches = new Set<number>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- bookkeeping only
	let twoFingerAt = 0;
	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		if (e.pointerType === 'pen') penSeen = true;
		if (e.pointerType === 'touch') {
			touches.add(e.pointerId);
			if (penSeen) return;
			if (touches.size > 1) {
				if (current && current.points.length < 12) twoFingerAt = performance.now();
				current = null;
				activeId = null;
				redraw();
				return;
			}
		}
		if (activeId !== null) return;
		activeId = e.pointerId;
		canvas.setPointerCapture(e.pointerId);
		current = { tool, color, size, points: [point(e)] };
	}
	function move(e: PointerEvent) {
		if (!current || e.pointerId !== activeId) return;
		const events = e.getCoalescedEvents?.() ?? [e];
		if (current.tool === 'line') current.points = [current.points[0], point(e)];
		else for (const ev of events) current.points.push(point(ev));
		redraw();
	}
	function up(e: PointerEvent) {
		touches.delete(e.pointerId);
		if (twoFingerAt && !touches.size) {
			if (performance.now() - twoFingerAt < 350) undo();
			twoFingerAt = 0;
		}
		if (e.pointerId !== activeId) return;
		activeId = null;
		if (!current) return;
		strokes = [...strokes, current];
		undone = [];
		current = null;
		redraw();
	}
	function undo() {
		const last = strokes.at(-1);
		if (!last) return;
		strokes = strokes.slice(0, -1);
		undone = [...undone, last];
		redraw();
	}
	function redo() {
		const next = undone.at(-1);
		if (!next) return;
		undone = undone.slice(0, -1);
		strokes = [...strokes, next];
		redraw();
	}
	function clear() {
		if (!strokes.length && !baseImage) return;
		undone = [...undone, ...[...strokes].reverse()];
		strokes = [];
		baseImage = null;
		redraw();
	}
	function save() {
		redraw(false); // the grid is a guide, not part of the drawing
		canvas.toBlob((blob) => {
			redraw();
			if (blob) onsave(blob);
		}, 'image/png');
	}
	function keys(e: KeyboardEvent) {
		if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
		e.preventDefault();
		e.stopPropagation();
		if (e.shiftKey) redo();
		else undo();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sketch" onkeydown={keys}>
	<div class="tools" role="toolbar" aria-label="Drawing tools">
		<div class="seg" role="radiogroup" aria-label="Tool">
			{#each [['pen', 'Pen', '✎'], ['marker', 'Marker', '▮'], ['line', 'Line', '╱'], ['eraser', 'Eraser', '◌']] as const as [id, label, icon] (id)}
				<button
					type="button"
					role="radio"
					aria-checked={tool === id}
					title={label}
					onclick={() => (tool = id)}><span aria-hidden="true">{icon}</span>{label}</button
				>
			{/each}
		</div>
		<div class="inks" role="radiogroup" aria-label="Colour">
			{#each INKS as [hex, name] (hex)}
				<button
					type="button"
					role="radio"
					class="ink"
					aria-checked={color === hex}
					aria-label={name}
					title={name}
					style:--ink={hex}
					onclick={() => {
						color = hex;
						if (tool === 'eraser') tool = 'pen';
					}}
				></button>
			{/each}
		</div>
		<label class="size"
			>Size <input
				type="range"
				min="1"
				max="16"
				bind:value={size}
				aria-label="Stroke size"
			/></label
		>
		<span class="spacer"></span>
		<button
			type="button"
			class="mini"
			aria-pressed={grid}
			onclick={() => (grid = !grid)}
			title="Guide grid (not saved)">Grid</button
		>
		<button
			type="button"
			class="mini icon"
			title="Undo (Ctrl+Z)"
			aria-label="Undo"
			disabled={!strokes.length}
			onclick={undo}>↶</button
		>
		<button
			type="button"
			class="mini icon"
			title="Redo (Ctrl+Shift+Z)"
			aria-label="Redo"
			disabled={!undone.length}
			onclick={redo}>↷</button
		>
		<button type="button" class="mini" onclick={clear}>Clear</button>
	</div>
	<canvas
		bind:this={canvas}
		width={W}
		height={H}
		class="t-{tool}"
		aria-label="Drawing area"
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
	></canvas>
	<div class="sketch-actions">
		<small>Draw with a mouse, finger or pen (pressure works). The grid is only a guide.</small>
		{#if oncancel}<button type="button" class="secondary" onclick={oncancel}>Cancel</button>{/if}
		<button
			type="button"
			class="primary"
			disabled={saving || (!strokes.length && !baseImage)}
			onclick={save}>{saving ? 'Saving…' : saveLabel}</button
		>
	</div>
</div>

<style>
	.sketch {
		display: flex;
		flex-direction: column;
		gap: 10px;
		height: 100%;
		min-height: 0;
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.seg {
		display: inline-flex;
		padding: 2px;
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
	}
	.seg button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		padding: 5px 9px;
	}
	.seg button[aria-checked='true'] {
		background: rgb(var(--c1) / 0.16);
		color: var(--text);
		box-shadow: 0 0 0 1px rgb(var(--c1) / 0.45) inset;
	}
	.inks {
		display: flex;
		gap: 5px;
	}
	.ink {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid transparent;
		background: var(--ink);
		box-shadow: 0 0 0 1px rgb(var(--hi) / 0.2);
		padding: 0;
	}
	.ink[aria-checked='true'] {
		border-color: var(--menu);
		box-shadow: 0 0 0 2px var(--cyan);
	}
	.size {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--muted);
	}
	.size input {
		width: 90px;
		accent-color: var(--cyan);
	}
	.spacer {
		flex: 1;
	}
	.mini[aria-pressed='true'] {
		background: rgb(var(--c1) / 0.14);
	}
	canvas {
		display: block;
		width: 100%;
		aspect-ratio: 4 / 3;
		border-radius: 10px;
		background: #f7f4ec;
		box-shadow:
			0 0 0 1px rgb(var(--hi) / 0.12),
			0 12px 40px -18px rgb(var(--lo) / 0.8);
		touch-action: none;
		cursor: crosshair;
		/* Fit the page on screen when the panel is expanded. */
		max-width: calc((88vh - 200px) * 4 / 3);
		margin: 0 auto;
	}
	canvas.t-eraser {
		cursor: cell;
	}
	.sketch-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-bottom: 14px;
	}
	.sketch-actions small {
		flex: 1;
		font-size: 11.5px;
		color: var(--dim);
	}
</style>
