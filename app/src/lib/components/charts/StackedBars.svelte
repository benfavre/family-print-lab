<script lang="ts">
	import { stack, thin, ticks, toneColor, type Tone } from './scale';

	// Columns (months, say) split into series (materials), with a legend. Series keep their colours.
	let {
		columns,
		series,
		values,
		label,
		format = (v: number) => String(v)
	}: {
		columns: { key: string; label: string }[];
		series: { key: string; label: string; tone: Tone }[];
		/** values[column][series] */
		values: number[][];
		label: string;
		format?: (v: number) => string;
	} = $props();
	const W = 600,
		H = 160,
		GAP = 0.3;
	const stacks = $derived(stack(values));
	const axis = $derived(ticks(Math.max(0, ...stacks.map((c) => c.at(-1)?.y1 ?? 0)), 3));
	const top = $derived(axis.at(-1) ?? 1);
	const band = $derived(W / Math.max(columns.length, 1));
	const y = (v: number) => H - (v / top) * H;
	const labels = $derived(
		thin(
			columns.map((c) => c.label),
			8
		)
	);
	const totals = $derived(series.map((_, s) => values.reduce((n, col) => n + (col[s] ?? 0), 0)));
</script>

<figure class="chart">
	<div class="y-axis" aria-hidden="true">
		{#each [...axis].reverse() as v (v)}<span>{format(v)}</span>{/each}
	</div>
	<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label={label}>
		{#each axis as v (v)}<line class="grid" x1="0" x2={W} y1={y(v)} y2={y(v)} />{/each}
		{#each columns as c, ci (c.key)}
			{#each series as s, si (s.key)}
				{@const seg = stacks[ci]?.[si]}
				{#if seg && seg.y1 > seg.y0}
					<rect
						x={ci * band + (band * GAP) / 2}
						width={band * (1 - GAP)}
						y={y(seg.y1)}
						height={Math.max(0, y(seg.y0) - y(seg.y1))}
						style:fill={toneColor(s.tone)}
					>
						<title>{c.label} · {s.label}: {format(seg.y1 - seg.y0)}</title>
					</rect>
				{/if}
			{/each}
		{/each}
	</svg>
	<div class="x-axis" aria-hidden="true">
		{#each labels as l, i (i)}
			{#if l !== null}<span style:left="{((i + 0.5) * band * 100) / W}%">{l}</span>{/if}
		{/each}
	</div>
	<figcaption>
		{#each series as s, i (s.key)}
			<span
				><i style:background={toneColor(s.tone)} aria-hidden="true"></i>{s.label}
				<b>{format(totals[i])}</b></span
			>
		{/each}
	</figcaption>
</figure>

<style>
	.chart {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 6px 8px;
		margin: 0;
	}
	svg {
		display: block;
		width: 100%;
		height: 160px;
		overflow: visible;
	}
	rect {
		stroke: var(--panel);
		stroke-width: 2px;
		vector-effect: non-scaling-stroke;
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
	.x-axis {
		grid-column: 2;
		position: relative;
		height: 14px;
		font-size: 11px;
		color: var(--dim);
	}
	.x-axis span {
		position: absolute;
		transform: translateX(-50%);
		white-space: nowrap;
	}
	figcaption {
		grid-column: 1 / -1;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		margin-top: 4px;
		font-size: 11.5px;
		color: var(--muted);
	}
	figcaption i {
		display: inline-block;
		width: 8px;
		height: 8px;
		margin-right: 5px;
		border-radius: 2px;
		vertical-align: middle;
	}
	figcaption b {
		margin-left: 4px;
		font-weight: 500;
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
	}
</style>
