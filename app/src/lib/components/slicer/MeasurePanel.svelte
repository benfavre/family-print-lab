<script lang="ts">
	import type { Vec3 } from '$lib/client/slicer/matrix';
	import { measure } from '$lib/client/slicer/measure';

	let { points = $bindable([]), close }: { points: Vec3[]; close: () => void } = $props();
	const result = $derived(measure(points));
	const axes = ['X', 'Y', 'Z'];
	const mm = (n: number) => n.toFixed(2);
	function setPoint(index: number, axis: number, value: number) {
		if (!Number.isFinite(value)) return;
		const next: Vec3[] = points.map((p) => [...p]);
		next[index][axis] = value;
		points = next;
	}
</script>

<section class="panel measure" aria-label="Measure">
	<header>
		<h2>Measure</h2>
		<button class="mini" onclick={close}>Done</button>
	</header>
	<p class="hint">Click two points on the models. A third click starts a new measurement.</p>
	<p class="hint">Coordinates are in project millimetres. Drag to orbit the view.</p>
	{#if result}
		<p class="distance" role="status">Distance: <strong>{mm(result.distance)} mm</strong></p>
		<p class="hint">
			X: {mm(Math.abs(result.delta[0]))} mm · Y: {mm(Math.abs(result.delta[1]))} mm · Z: {mm(
				Math.abs(result.delta[2])
			)} mm
		</p>
	{:else}
		<p role="status">{points.length ? 'Choose the second point.' : 'Choose the first point.'}</p>
	{/if}
	{#each points as point, index (index)}
		<fieldset>
			<legend>Point {index + 1}</legend>
			<div class="coords">
				{#each axes as axis, k (axis)}
					<label
						>{axis}<input
							type="number"
							step="0.01"
							aria-label={`Point ${index + 1} ${axis}`}
							value={point[k]}
							onchange={(e) => setPoint(index, k, e.currentTarget.valueAsNumber)}
						/></label
					>
				{/each}
			</div>
		</fieldset>
	{/each}
	<div class="actions">
		<button
			class="mini"
			onclick={() =>
				(points = [
					[0, 0, 0],
					[0, 0, 0]
				])}>Enter coordinates</button
		>
		<button class="mini" disabled={!points.length} onclick={() => (points = [])}>Clear</button>
	</div>
</section>

<style>
	.measure {
		padding: 12px;
	}
	header,
	.actions,
	.coords {
		display: flex;
		gap: 8px;
	}
	header {
		align-items: center;
		justify-content: space-between;
	}
	h2 {
		margin: 0;
		font-size: 14px;
	}
	.distance {
		font-size: 16px;
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: 12px 0;
	}
	legend {
		font-size: 12px;
		color: var(--muted);
		margin-bottom: 4px;
	}
	label {
		flex: 1;
		min-width: 0;
		font-size: 12px;
	}
	input {
		width: 100%;
		min-width: 0;
	}
</style>
