<script lang="ts">
	import type { PreviewLayer } from '$lib/shared/slicer/preview';
	import { clock } from '$lib/shared/gcode-preview';

	// Time per layer as thin bars; the shown layers are bright, the rest faint. Hover names a bar, a
	// click shows up to that layer.
	let {
		layers,
		from,
		to,
		onpick
	}: {
		layers: PreviewLayer[];
		from: number;
		to: number;
		onpick: (layer: number) => void;
	} = $props();
	const W = 600,
		H = 56;
	const top = $derived(Math.max(1, ...layers.map((l) => l.seconds ?? 0)));
	const slowest = $derived(
		layers.reduce((best, l, i) => ((l.seconds ?? 0) > (layers[best]?.seconds ?? 0) ? i : best), 0)
	);
	const step = $derived(W / Math.max(1, layers.length));
	/** Bars as one path each for inside and outside the shown range (a plate can have thousands). */
	function bars(inside: boolean) {
		let d = '';
		const gap = step > 4 ? 1 : 0;
		layers.forEach((l, i) => {
			if ((i >= from && i <= to) !== inside || !l.seconds) return;
			const h = Math.max(1, (l.seconds / top) * H);
			d += `M${(i * step).toFixed(2)},${H}h${Math.max(0.6, step - gap).toFixed(2)}v${(-h).toFixed(2)}h${(-Math.max(0.6, step - gap)).toFixed(2)}Z`;
		});
		return d;
	}
	let hover = $state<number | null>(null);
	const layerAt = (e: PointerEvent) => {
		const box = (e.currentTarget as SVGElement).getBoundingClientRect();
		return Math.min(
			layers.length - 1,
			Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * layers.length))
		);
	};
</script>

{#if layers.some((l) => l.seconds)}
	<figure class="layer-times">
		<!-- The layer sliders do the same by keyboard; the bars are a pointer shortcut. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<svg
			viewBox="0 0 {W} {H}"
			preserveAspectRatio="none"
			role="img"
			aria-label="Time per layer. The slowest is layer {slowest + 1}, {clock(
				layers[slowest]?.seconds
			)}."
			onpointermove={(e) => (hover = layerAt(e))}
			onpointerleave={() => (hover = null)}
			onclick={(e) => onpick(layerAt(e as unknown as PointerEvent))}
		>
			<path class="out" d={bars(false)} />
			<path class="in" d={bars(true)} />
			{#if hover !== null}<rect
					class="hover"
					x={hover * step}
					y="0"
					width={Math.max(1, step)}
					height={H}
				/>{/if}
		</svg>
		<figcaption>
			{#if hover !== null}
				Layer {hover + 1} · {layers[hover].z} mm · {clock(layers[hover].seconds)}
			{:else}
				Time per layer · slowest: layer {slowest + 1}, {clock(layers[slowest]?.seconds)}
			{/if}
		</figcaption>
	</figure>
{/if}

<style>
	.layer-times {
		margin: 0;
	}
	svg {
		display: block;
		width: 100%;
		height: 56px;
		cursor: pointer;
	}
	.in {
		fill: rgb(var(--c1) / 0.85);
	}
	.out {
		fill: rgb(var(--hi) / 0.16);
	}
	.hover {
		fill: rgb(var(--hi) / 0.12);
	}
	figcaption {
		margin-top: 4px;
		font-size: 11.5px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
</style>
