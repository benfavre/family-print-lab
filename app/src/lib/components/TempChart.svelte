<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';

	// Nozzle, bed and chamber over the last 30 minutes, from the live printer reports seen by this tab.
	const { lab } = useApp();
	const W = 300,
		H = 90;
	const series = [
		{ key: 'nozzle', label: 'Nozzle', tone: 'amber' },
		{ key: 'bed', label: 'Bed', tone: 'cyan' },
		{ key: 'chamber', label: 'Chamber', tone: 'violet' }
	] as const;
	const data = $derived(lab.temps);
	const span = $derived.by(() => {
		const end = data.at(-1)?.t ?? Date.now();
		const start = Math.min(data[0]?.t ?? end, end - 5 * 60_000);
		return { start, end };
	});
	const top = $derived(
		Math.max(
			60,
			...data.flatMap((d) => [d.nozzle ?? 0, d.bed ?? 0]),
			lab.printer.state?.nozzleTarget ?? 0
		) * 1.08
	);
	const x = (t: number) => ((t - span.start) / Math.max(span.end - span.start, 1)) * W;
	const y = (v: number) => H - (v / top) * H;
	function path(key: 'nozzle' | 'bed' | 'chamber') {
		let d = '';
		for (const p of data) {
			const v = p[key];
			if (v === null) continue;
			d += `${d ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
		}
		return d;
	}
	const targets = $derived(
		[
			{ v: lab.printer.state?.nozzleTarget, tone: 'amber' },
			{ v: lab.printer.state?.bedTarget, tone: 'cyan' }
		].filter((t): t is { v: number; tone: string } => !!t.v)
	);
	const minutes = $derived(Math.round((span.end - span.start) / 60_000));
</script>

<figure class="temp-chart">
	{#if data.length > 1}
		<svg
			viewBox="0 0 {W} {H}"
			preserveAspectRatio="none"
			role="img"
			aria-label="Temperatures over the last {minutes} minutes"
		>
			{#each [0.25, 0.5, 0.75] as g (g)}<line
					class="grid"
					x1="0"
					x2={W}
					y1={H * g}
					y2={H * g}
				/>{/each}
			{#each targets as t (t.tone)}<line
					class="target t-{t.tone}"
					x1="0"
					x2={W}
					y1={y(t.v)}
					y2={y(t.v)}
				/>{/each}
			{#each series as s (s.key)}<path class="line t-{s.tone}" d={path(s.key)} />{/each}
		</svg>
		<figcaption>
			{#each series as s (s.key)}
				{@const v = data.at(-1)?.[s.key]}
				<span
					><i class="t-{s.tone}" aria-hidden="true"></i>{s.label}
					{v === null || v === undefined ? '—' : `${Math.round(v)}°`}</span
				>
			{/each}
			<span class="span">last {minutes} min · dashed = target</span>
		</figcaption>
	{:else}
		<p class="waiting">Temperature history builds up while this page is open.</p>
	{/if}
</figure>

<style>
	.temp-chart {
		margin: 12px 0 0;
	}
	svg {
		display: block;
		width: 100%;
		height: 90px;
		overflow: visible;
	}
	.grid {
		stroke: var(--line);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}
	.line {
		fill: none;
		stroke-width: 1.8;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}
	.target {
		stroke-width: 1;
		stroke-dasharray: 4 4;
		opacity: 0.6;
		vector-effect: non-scaling-stroke;
	}
	.t-amber {
		stroke: var(--amber);
		background: var(--amber);
	}
	.t-cyan {
		stroke: var(--cyan);
		background: var(--cyan);
	}
	.t-violet {
		stroke: var(--violet);
		background: var(--violet);
	}
	figcaption {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		margin-top: 8px;
		font-size: 11.5px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	figcaption i {
		display: inline-block;
		width: 8px;
		height: 2px;
		margin-right: 5px;
		vertical-align: middle;
	}
	.span {
		margin-left: auto;
		color: var(--dim);
	}
	.waiting {
		margin: 0;
		font-size: 12px;
		color: var(--dim);
	}
</style>
