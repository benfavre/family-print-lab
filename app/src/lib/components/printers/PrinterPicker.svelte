<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { printerStateLabel } from '$lib/client/format';
	import { modelShort, sameModel } from '$lib/shared/printers/models';
	import type { PrinterStatus } from '$lib/shared/domain';

	// Which printer to send to: printers that fit the sliced file first, the others shown but not choosable.
	let {
		value = $bindable(),
		modelId = '',
		label = 'Printer'
	}: { value: string | null; modelId?: string; label?: string } = $props();
	const { lab } = useApp();
	const reason = (p: PrinterStatus) =>
		p.enabled === false
			? 'switched off'
			: modelId && p.model && !sameModel(modelId, p.model)
				? `sliced for the ${modelShort(modelId)}`
				: '';
	const options = $derived(
		[...lab.printerList].sort((a, b) => Number(!!reason(a)) - Number(!!reason(b)))
	);
</script>

<label class="picker">
	<span>{label}</span>
	<select bind:value aria-label={label}>
		{#each options as p (p.id)}
			{@const why = reason(p)}
			<option value={p.id} disabled={!!why}
				>{p.name} · {why || printerStateLabel(p).toLowerCase()}</option
			>
		{/each}
	</select>
</label>

<style>
	.picker {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: center;
		gap: 10px;
		font-size: 13px;
		color: var(--muted);
	}
	select {
		min-width: 0;
	}
</style>
