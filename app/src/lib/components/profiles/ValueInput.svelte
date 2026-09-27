<script lang="ts">
	import type { ConfigValue } from '$lib/shared/slicer/project';

	// One setting's value: a text box, or one per slot for per-extruder/per-filament vectors. Long or
	// multi-line text (G-code) gets a text area.
	let {
		value,
		label,
		readonly = false,
		onchange
	}: {
		value: ConfigValue;
		label: string;
		readonly?: boolean;
		onchange: (v: ConfigValue) => void;
	} = $props();

	const long = (s: string) => s.includes('\n') || s.length > 80;
	const items = $derived(Array.isArray(value) ? value : [value]);
	function set(i: number, v: string) {
		if (!Array.isArray(value)) return onchange(v);
		const next = [...value];
		next[i] = v;
		onchange(next);
	}
</script>

<span class="value" class:vector={Array.isArray(value)}>
	{#each items as item, i (i)}
		{@const name = Array.isArray(value) && items.length > 1 ? `${label} (${i + 1})` : label}
		{#if long(item)}
			<textarea
				aria-label={name}
				{readonly}
				rows={Math.min(10, item.split('\n').length + 1)}
				value={item}
				onchange={(e) => set(i, e.currentTarget.value)}></textarea>
		{:else}
			<input
				aria-label={name}
				{readonly}
				value={item}
				onchange={(e) => set(i, e.currentTarget.value)}
			/>
		{/if}
	{/each}
</span>

<style>
	.value {
		display: flex;
		gap: 6px;
		min-width: 0;
		flex-wrap: wrap;
	}
	input,
	textarea {
		flex: 1 1 90px;
		min-width: 0;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		padding: 4px 8px;
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		font: 400 13px var(--mono);
	}
	textarea {
		flex-basis: 100%;
		resize: vertical;
		font-size: 12px;
	}
	input[readonly],
	textarea[readonly] {
		color: var(--muted);
		background: transparent;
	}
	input:focus,
	textarea:focus {
		outline: none;
		border-color: rgb(var(--c1) / 0.65);
	}
</style>
