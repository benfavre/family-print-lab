<script lang="ts">
	import { untrack } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import Modal from '../Modal.svelte';
	import { DRYING_HOURS, dryingDefaults, dryingRange } from '$lib/shared/ams';
	import type { AmsUnit } from '$lib/shared/printers/status';

	// Start drying in an AMS 2 Pro or AMS HT: temperature and time within what the unit allows.
	let {
		printerId,
		unit,
		name,
		onclose
	}: { printerId: string; unit: AmsUnit; name: string; onclose: () => void } = $props();
	const { lab } = useApp();
	const range = $derived(dryingRange(unit.model) ?? { min: 45, max: 65 });
	const start = untrack(() => dryingDefaults(unit));
	let temp = $state(start.temp);
	let hours = $state(start.hours);
	let rotate = $state(false);
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await lab.call(
			'POST',
			`/api/printers/${printerId}/ams/drying`,
			{
				action: 'start',
				amsId: unit.id,
				temp: Number(temp),
				hours: Number(hours),
				filament: start.filament,
				rotateTray: rotate
			},
			`${name} is drying.`
		);
		busy = false;
		if (ok) onclose();
	}
</script>

<Modal id="ams-drying" {onclose} {busy}>
	<form onsubmit={submit}>
		<div class="dialog-top">
			<div>
				<div class="eyebrow">DRY FILAMENT</div>
				<h2 id="ams-drying-title">{name}</h2>
			</div>
		</div>
		<div class="fields-row">
			<label class="field"
				>Temperature (°C)<input
					type="number"
					min={range.min}
					max={range.max}
					required
					bind:value={temp}
				/><small>{range.min}–{range.max} °C on this unit.</small></label
			>
			<label class="field"
				>Hours<input
					type="number"
					min={DRYING_HOURS.min}
					max={DRYING_HOURS.max}
					required
					bind:value={hours}
				/><small>1 to 24.</small></label
			>
		</div>
		<label class="toggle"
			><input type="checkbox" bind:checked={rotate} /> Turn the spools while drying</label
		>
		<p class="note">
			For turning, unload the filament first so the spools can move freely (Bambu’s advice).
		</p>
		<div class="dialog-actions">
			<span></span>
			<div>
				<button type="button" class="secondary" onclick={onclose}>Cancel</button>
				<button class="primary" disabled={busy}>Start drying</button>
			</div>
		</div>
	</form>
</Modal>

<style>
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		margin-top: 6px;
	}
	.note {
		font-size: 12px;
		color: var(--dim);
		margin: 8px 0 0;
	}
</style>
