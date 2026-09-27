<script lang="ts">
	import { linear, linePath, toneColor, type Tone } from './scale';

	// A tiny trend line with no axes, for beside a number.
	let {
		values,
		label,
		tone = 'cyan'
	}: { values: (number | null)[]; label: string; tone?: Tone } = $props();
	const W = 80,
		H = 22;
	const d = $derived.by(() => {
		const known = values.filter((v): v is number => v !== null);
		const max = Math.max(...known, 0),
			min = Math.min(...known, 0);
		const x = linear([0, Math.max(values.length - 1, 1)], [1, W - 1]);
		const y = linear([min, max === min ? min + 1 : max], [H - 2, 2]);
		return linePath(values.map((v, i) => (v === null ? null : { x: x(i), y: y(v) })));
	});
</script>

<svg class="spark" viewBox="0 0 {W} {H}" role="img" aria-label={label}>
	<title>{label}</title>
	<path {d} style:stroke={toneColor(tone)} />
</svg>

<style>
	.spark {
		display: inline-block;
		width: 80px;
		height: 22px;
		vertical-align: middle;
	}
	path {
		fill: none;
		stroke-width: 1.6;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
</style>
