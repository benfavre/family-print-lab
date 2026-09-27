<script lang="ts">
	import { toneColor, TONES, type Tone } from './scale';

	// Horizontal bars, one row per item: label, bar, value. Rows keep their own colour when given one.
	let {
		items,
		label,
		format = (v: number) => String(v),
		tone = 'cyan'
	}: {
		items: { key: string; label: string; value: number; hint?: string; tone?: Tone }[];
		label: string;
		format?: (v: number) => string;
		/** Colour for rows without their own. */
		tone?: Tone | 'series';
	} = $props();
	const max = $derived(Math.max(0, ...items.map((i) => i.value)));
	const colour = (i: (typeof items)[number], n: number) =>
		toneColor(i.tone ?? (tone === 'series' ? TONES[n % TONES.length] : tone));
</script>

<ul class="bars" aria-label={label}>
	{#each items as item, n (item.key)}
		<li title="{item.label}: {format(item.value)}{item.hint ? ` · ${item.hint}` : ''}">
			<span class="name">{item.label}</span>
			<svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
				<rect class="track" x="0" y="0" width="100" height="10" rx="0" />
				{#if item.value > 0}
					<rect
						x="0"
						y="0"
						width={Math.max(0.8, max ? (item.value / max) * 100 : 0)}
						height="10"
						style:fill={colour(item, n)}
					/>
				{/if}
			</svg>
			<span class="value">{format(item.value)}</span>
			{#if item.hint}<span class="hint">{item.hint}</span>{/if}
		</li>
	{/each}
</ul>

<style>
	.bars {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		grid-template-columns: minmax(70px, 34%) 1fr auto;
		align-items: center;
		gap: 2px 10px;
		font-size: 12.5px;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-2);
	}
	svg {
		display: block;
		width: 100%;
		height: 10px;
		border-radius: 4px;
		overflow: hidden;
	}
	.track {
		fill: rgb(var(--hi) / 0.05);
	}
	.value {
		color: var(--text);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.hint {
		grid-column: 2 / 4;
		font-size: 11px;
		color: var(--dim);
	}
</style>
