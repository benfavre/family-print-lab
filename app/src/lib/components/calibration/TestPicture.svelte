<script lang="ts">
	import type { CalibKind } from '$lib/shared/slicer-calibration';

	// A small drawing of each calibration print and what a good result looks like (the highlighted
	// block, line, corner or band), to read the real print against.
	let { kind, label }: { kind: CalibKind; label: string } = $props();

	const grid = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ r, c, i: r * 3 + c })));
	const lines = [0, 1, 2, 3, 4, 5, 6];
	const chevrons = [0, 1, 2, 3, 4, 5, 6, 7];
	const bands = [0, 1, 2, 3, 4, 5];
</script>

<svg viewBox="0 0 120 72" role="img" aria-label={label} class="pic">
	{#if kind === 'flow_rate'}
		{#each grid as b (b.i)}
			<rect
				x={14 + b.c * 32}
				y={4 + b.r * 22}
				width="26"
				height="18"
				rx="2"
				class:good={b.i === 4}
				class="block"
			/>
			{#each [0, 1, 2, 3, 4] as l (l)}
				<line
					x1={17 + b.c * 32}
					x2={37 + b.c * 32}
					y1={7 + b.r * 22 + l * 3}
					y2={7 + b.r * 22 + l * 3}
					class="hatch"
					stroke-dasharray={b.i < 4 ? '3 2' : 'none'}
					stroke-width={b.i > 4 ? 2.2 : 1.2}
				/>
			{/each}
		{/each}
	{:else if kind === 'pa_line'}
		{#each lines as l (l)}
			<path
				d="M12 {8 + l * 9}h30M42 {8 + l * 9}h36M78 {8 + l * 9}h30"
				class="line"
				class:good={l === 3}
			/>
			<path
				d="M42 {8 + l * 9}h{l < 3 ? 4 - l : 0}M78 {8 + l * 9}h{l > 3 ? -(l - 3) * 1.5 : 0}"
				class="blob"
				stroke-width={l < 3 ? 4 - l : 1}
			/>
			<text x="4" y={10 + l * 9} class="num">{l}</text>
		{/each}
	{:else if kind === 'pa_pattern'}
		{#each chevrons as c (c)}
			<path
				d="M{30 + c * 11} 8L{14 + c * 11} 36L{30 + c * 11} 64"
				class="line"
				class:good={c === 4}
				fill="none"
			/>
			{#if c < 4}<circle cx={14 + c * 11} cy="36" r={2.6 - c * 0.5} class="bulge" />{/if}
			{#if c > 4}<path
					d="M{15 + c * 11} 33l-2 3l2 3"
					class="gap"
					stroke-width="2.4"
					fill="none"
				/>{/if}
		{/each}
	{:else if kind === 'pa_tower' || kind === 'temp_tower' || kind === 'vfa'}
		<rect x="38" y="4" width="44" height="64" rx="2" class="block" />
		{#each bands as b (b)}
			<rect x="38" y={4 + b * 10.6} width="44" height="10.6" class="band" class:good={b === 2} />
			{#if kind === 'pa_tower'}
				<path
					d="M38 {4 + b * 10.6}v10.6M82 {4 + b * 10.6}v10.6"
					class="edge"
					stroke-dasharray={b < 3 ? 'none' : '2 2'}
					stroke-width={b > 3 ? 2.6 : 1.2}
				/>
			{:else if kind === 'temp_tower'}
				<path d="M82 {6 + b * 10.6}l12 0l-12 7z" class="wedge" />
				<text x="12" y={11 + b * 10.6} class="num">{230 - b * 5}°</text>
			{:else}
				{#each [0, 1, 2, 3, 4, 5, 6] as v (v)}
					{#if b < 3}<line
							x1={42 + v * 6}
							x2={42 + v * 6}
							y1={6 + b * 10.6}
							y2={13 + b * 10.6}
							class="artifact"
						/>{/if}
				{/each}
				<text x="10" y={11 + b * 10.6} class="num">{200 - b * 30}</text>
			{/if}
		{/each}
	{:else if kind === 'retraction'}
		<rect x="18" y="62" width="84" height="6" rx="1" class="block" />
		<rect x="28" y="6" width="14" height="56" class="block" />
		<rect x="78" y="6" width="14" height="56" class="block" />
		{#each bands as b (b)}
			<rect x="26" y={50 - b * 9} width="68" height="9" class="band" class:good={b === 3} />
			{#if b < 3}
				<path
					d="M42 {54 - b * 9}q18 {6 - b * 2} 36 0"
					class="string"
					stroke-width={1.4 - b * 0.4}
				/>
			{/if}
		{/each}
	{:else if kind === 'max_volumetric'}
		<path d="M44 68h32l6-60h-44z" class="block" />
		<path d="M41 22l-2-4l3-3l-3-3" class="gap" fill="none" stroke-width="2" />
		<path d="M79 22l2-4l-3-3l3-3" class="gap" fill="none" stroke-width="2" />
		<path d="M96 68v-46M92 68h8M92 22h8" class="ruler" />
		<text x="100" y="47" class="num">h</text>
	{/if}
</svg>

<style>
	.pic {
		width: 100%;
		max-width: 260px;
		height: auto;
		display: block;
		color: var(--muted);
	}
	.block {
		fill: rgb(var(--hi) / 0.05);
		stroke: var(--line-strong);
	}
	.block.good,
	.band.good {
		stroke: var(--cyan);
		stroke-width: 1.6;
		fill: rgb(var(--c1) / 0.12);
	}
	.band {
		fill: transparent;
		stroke: var(--line);
	}
	.hatch,
	.line,
	.edge,
	.ruler {
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linecap: round;
	}
	.line.good {
		stroke: var(--cyan);
		stroke-width: 2;
	}
	.blob,
	.bulge,
	.gap,
	.string,
	.artifact {
		stroke: var(--amber);
		fill: none;
		stroke-linecap: round;
	}
	.bulge {
		fill: var(--amber);
	}
	.artifact {
		stroke-width: 0.8;
	}
	.wedge {
		fill: rgb(var(--hi) / 0.08);
		stroke: var(--line-strong);
	}
	.num {
		fill: var(--dim);
		font: 500 7px var(--mono, monospace);
	}
</style>
