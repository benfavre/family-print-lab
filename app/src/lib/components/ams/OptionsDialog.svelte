<script lang="ts">
	import { untrack } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import Modal from '../Modal.svelte';
	import type { AmsOptions } from '$lib/shared/ams';

	// The AMS reading options, for every unit on the printer (Bambu Studio's AMS settings).
	let {
		printerId,
		options,
		onclose
	}: { printerId: string; options: AmsOptions | null; onclose: () => void } = $props();
	const { lab } = useApp();
	const start = untrack(() => options);
	let f = $state({
		startupRead: start?.startupRead ?? true,
		trayRead: start?.trayRead ?? true,
		remainCalibrate: start?.remainCalibrate ?? true
	});
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await lab.call(
			'POST',
			`/api/printers/${printerId}/ams/options`,
			f,
			'Saved on the printer.'
		);
		busy = false;
		if (ok) onclose();
	}
</script>

<Modal id="ams-options" {onclose} {busy}>
	<form onsubmit={submit}>
		<div class="dialog-top">
			<div>
				<div class="eyebrow">AMS</div>
				<h2 id="ams-options-title">AMS options</h2>
			</div>
		</div>
		{#if !start}
			<p class="note">The printer has not said how these are set; saving sets them as shown.</p>
		{/if}
		<label class="toggle"
			><input type="checkbox" bind:checked={f.trayRead} /> Read the RFID tag when a spool goes in</label
		>
		<label class="toggle"
			><input type="checkbox" bind:checked={f.startupRead} /> Read every tag when the printer starts</label
		>
		<label class="toggle"
			><input type="checkbox" bind:checked={f.remainCalibrate} /> Estimate what is left on each spool</label
		>
		<div class="dialog-actions">
			<span></span>
			<div>
				<button type="button" class="secondary" onclick={onclose}>Cancel</button>
				<button class="primary" disabled={busy}>Save</button>
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
		margin: 6px 0;
	}
	.note {
		font-size: 12px;
		color: var(--dim);
		margin: 0 0 8px;
	}
</style>
