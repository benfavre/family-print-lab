<script lang="ts">
	import { linear, linePath, thin, ticks, toneColor, type Tone } from './scale';

	// One series over time (a line with a dot per point), gaps where a value is missing.
	let {
		points,
		label,
		max = null,
		format = (v: number) => String(v),
		tone = 'cyan'
	}: {
		points: { label: string; value: number | null; hint?: string }[];
		label: string;
		/** Fixed top of the axis (e.g. 1 for a rate); otherwise from the data. */
		max?: number | null;
		format?: (v: number) => string;
		tone?: Tone;
	} = $props();
	const W = 600,
		H = 160;
	const axis = $derived(
		max !== null ? [0, max / 2, max] : ticks(Math.max(0, ...points.map((p) => p.value ?? 0)), 3)
	);
	const top = $derived(axis.at(-1) ?? 1);
	const x = $derived(linear([0, Math.max(points.length - 1, 1)], [8, W - 8]));
	const y = $derived(linear([0, top], [H - 4, 4]));
	const xy = $derived(
		points.map((p, i) => (p.value === null ? null : { x: x(i), y: y(p.value), p }))
	);
	const labels = $derived(
		thin(
			points.map((p) => p.label),
			6
		)
	);
</script>

<figure class="chart">
	<div class="y-axis" aria-hidden="true">
		{#each [...axis].reverse() as v (v)}<span>{format(v)}</span>{/each}
	</div>
	<div class="area">
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
			{#each axis as v (v)}<line class="grid" x1="0" x2={W} y1={y(v)} y2={y(v)} />{/each}
			<path class="line" d={linePath(xy)} style:stroke={toneColor(tone)} />
		</svg>
		<!-- Dots are HTML so they stay round while the plot stretches; each has a tooltip. -->
		{#each xy as d, i (i)}
			{#if d}
				<span
					class="dot"
					style:left="{(d.x / W) * 100}%"
					style:top="{(d.y / H) * 100}%"
					style:background={toneColor(tone)}
					title="{d.p.label}: {format(d.p.value ?? 0)}{d.p.hint ? ` · ${d.p.hint}` : ''}"
				></span>
			{/if}
		{/each}
	</div>
	<div class="x-axis" aria-hidden="true">
		{#each labels as l, i (i)}
			{#if l !== null}<span style:left="{(x(i) / W) * 100}%">{l}</span>{/if}
		{/each}
	</div>
	<!-- The same numbers for screen readers (the dots' tooltips need a mouse). -->
	<table class="sr-only">
		<caption>{label}</caption>
		<tbody>
			{#each points as p, i (i)}
				<tr>
					<th scope="row">{p.label}</th>
					<td>{p.value === null ? '—' : format(p.value)}{p.hint ? ` · ${p.hint}` : ''}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</figure>

<style>
	.chart {
		position: relative;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 6px 8px;
		margin: 0;
	}
	.area {
		position: relative;
	}
	svg {
		display: block;
		width: 100%;
		height: 160px;
		overflow: visible;
	}
	.y-axis {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		height: 160px;
		font-size: 11px;
		color: var(--dim);
		text-align: right;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.grid {
		stroke: var(--line);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}
	.line {
		fill: none;
		stroke-width: 2;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}
	.dot {
		position: absolute;
		width: 8px;
		height: 8px;
		margin: -4px 0 0 -4px;
		border-radius: 50%;
		box-shadow: 0 0 0 2px var(--panel);
	}
	.dot::before {
		/* A bigger hover target than the dot. */
		content: '';
		position: absolute;
		inset: -6px;
	}
	.x-axis {
		grid-column: 2;
		position: relative;
		height: 14px;
		font-size: 11px;
		color: var(--dim);
		font-variant-numeric: tabular-nums;
	}
	.x-axis span {
		position: absolute;
		transform: translateX(-50%);
		white-space: nowrap;
	}
</style>
