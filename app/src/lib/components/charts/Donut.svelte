<script lang="ts">
	import { arc, slices, toneColor, type Tone } from './scale';

	// Shares of a whole as a ring, with a legend giving each value and share.
	let {
		items,
		label,
		format = (v: number) => String(v),
		center = ''
	}: {
		items: { key: string; label: string; value: number; tone: Tone; hint?: string }[];
		label: string;
		format?: (v: number) => string;
		/** Short text in the middle (the total, usually). */
		center?: string;
	} = $props();
	const S = 120,
		R = 56,
		INNER = 38;
	const parts = $derived(slices(items));
	const pct = (share: number) => `${Math.round(share * 100)}%`;
</script>

<figure class="donut">
	<svg viewBox="0 0 {S} {S}" role="img" aria-label={label}>
		{#if !parts.length}<circle class="empty" cx={S / 2} cy={S / 2} r={(R + INNER) / 2} />{/if}
		{#each parts as p (p.item.key)}
			<path d={arc(S / 2, S / 2, R, INNER, p.a0, p.a1)} style:fill={toneColor(p.item.tone)}>
				<title>{p.item.label}: {format(p.item.value)} ({pct(p.share)})</title>
			</path>
		{/each}
		{#if center}<text x={S / 2} y={S / 2} dy="0.35em">{center}</text>{/if}
	</svg>
	<figcaption>
		<ul>
			{#each parts as p (p.item.key)}
				<li>
					<i style:background={toneColor(p.item.tone)} aria-hidden="true"></i>
					<span class="name">{p.item.label}</span>
					<span class="value">{format(p.item.value)}</span>
					<span class="share">{pct(p.share)}</span>
				</li>
			{/each}
		</ul>
	</figcaption>
</figure>

<style>
	.donut {
		display: grid;
		grid-template-columns: 120px 1fr;
		align-items: center;
		gap: 16px;
		margin: 0;
	}
	svg {
		width: 120px;
		height: 120px;
	}
	path {
		stroke: var(--panel);
		stroke-width: 2;
	}
	.empty {
		fill: none;
		stroke: rgb(var(--hi) / 0.06);
		stroke-width: 18;
	}
	text {
		fill: var(--text);
		font-size: 13px;
		font-weight: 600;
		text-anchor: middle;
		font-variant-numeric: tabular-nums;
	}
	ul {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 12.5px;
	}
	li {
		display: grid;
		grid-template-columns: 8px 1fr auto 3.2em;
		align-items: center;
		gap: 8px;
	}
	i {
		width: 8px;
		height: 8px;
		border-radius: 2px;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-2);
	}
	.value {
		font-variant-numeric: tabular-nums;
	}
	.share {
		color: var(--dim);
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 420px) {
		.donut {
			grid-template-columns: 1fr;
			justify-items: center;
		}
		figcaption {
			width: 100%;
		}
	}
</style>
