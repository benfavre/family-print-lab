<script lang="ts">
	import { temp as tempLabel } from '$lib/client/format';

	// One heater: what it reads now, and a target to set (or switch off). Disabled with a reason when the
	// printer cannot take it.
	let {
		label,
		now,
		target,
		max,
		reason,
		busy = false,
		set
	}: {
		label: string;
		now: number | null | undefined;
		target: number | null | undefined;
		max: number | null;
		/** Why this heater cannot be set, or null. */
		reason: string | null;
		busy?: boolean;
		set: (temp: number) => void;
	} = $props();
	let value = $state('');
	const n = $derived(Number(value));
	const invalid = $derived(
		value === '' || !Number.isInteger(n) || n < 0 || (max !== null && n > max)
	);
	const id = $props.id();
</script>

<div class="temp-row" class:off={!!reason}>
	<label for={id}>{label}</label>
	<span class="now">{tempLabel(now, target)}</span>
	<div class="set">
		<input
			{id}
			type="number"
			inputmode="numeric"
			min="0"
			max={max ?? undefined}
			step="1"
			placeholder={max ? `0–${max}` : '°C'}
			bind:value
			disabled={!!reason || busy}
			title={reason ?? undefined}
			onkeydown={(e) => {
				if (e.key === 'Enter' && !invalid) set(n);
			}}
		/>
		<button
			class="mini"
			disabled={!!reason || busy || invalid}
			title={reason ?? (max !== null && n > max ? `Up to ${max} °C` : undefined)}
			onclick={() => set(n)}>Set</button
		>
		<button
			class="mini"
			disabled={!!reason || busy || !target}
			title={reason ?? undefined}
			onclick={() => set(0)}>Off</button
		>
	</div>
	{#if reason}<small class="why">{reason}</small>{/if}
</div>

<style>
	.temp-row {
		display: grid;
		grid-template-columns: minmax(90px, 1fr) auto;
		align-items: center;
		gap: 4px 10px;
		padding: 6px 0;
	}
	.temp-row label {
		font-size: 13px;
		color: var(--text-2);
	}
	.now {
		font-variant-numeric: tabular-nums;
		font-size: 13px;
		text-align: right;
	}
	.set {
		grid-column: 1 / -1;
		display: flex;
		gap: 6px;
	}
	.set input {
		width: 90px;
		padding: 4px 8px;
		border-radius: var(--r-sm);
		border: 1px solid var(--line);
		background: transparent;
	}
	.why {
		grid-column: 1 / -1;
		color: var(--muted);
		font-size: 12px;
	}
	.off label {
		color: var(--muted);
	}
</style>
