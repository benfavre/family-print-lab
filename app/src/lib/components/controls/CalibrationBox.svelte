<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { controlTarget, runCommand } from '$lib/client/modules/controls/commands';
	import {
		CALIBRATION_LABELS,
		calibrationReason,
		calibrationSteps,
		type CalibrationChoice
	} from '$lib/shared/controls';
	import type { PrinterStatus } from '$lib/shared/domain';

	// The printer's own calibration (the steps this model offers), idle only.
	let { printer, offline }: { printer: PrinterStatus; offline: string | null } = $props();
	const app = useApp();
	const t = $derived(controlTarget(printer));
	const steps = $derived(calibrationSteps(t));
	let chosen = $state<CalibrationChoice>({ bedLeveling: true, vibration: true });
	const picked = $derived(
		Object.fromEntries(steps.map((k) => [k, !!chosen[k]])) as CalibrationChoice
	);
	const reason = $derived(offline ?? calibrationReason(t, picked));
	let busy = $state(false);

	async function start() {
		const names = steps.filter((k) => picked[k]).map((k) => CALIBRATION_LABELS[k].toLowerCase());
		if (
			!(await app.ui.ask(
				'Start calibration?',
				`The printer runs ${names.join(', ')}. It takes a while; keep the plate empty and the door closed.`,
				'Calibrate'
			))
		)
			return;
		busy = true;
		try {
			await runCommand(app, printer, 'print.calibration', { ...picked }, 'Calibration started.');
		} finally {
			busy = false;
		}
	}
</script>

<div class="group">
	<h3>Calibration</h3>
	<div class="row">
		{#each steps as step (step)}
			<label class="check"
				><input
					type="checkbox"
					checked={!!chosen[step]}
					onchange={(e) => (chosen = { ...chosen, [step]: e.currentTarget.checked })}
				/>
				{CALIBRATION_LABELS[step]}</label
			>
		{/each}
	</div>
	<button class="mini" disabled={!!reason || busy} title={reason ?? undefined} onclick={start}
		>Start calibration</button
	>
	{#if reason && !offline}<small class="why">{reason}</small>{/if}
</div>

<style>
	.group {
		padding: 10px 0;
		border-top: 1px solid var(--line);
	}
	h3 {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
		margin: 0 0 6px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		margin-bottom: 8px;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
	}
	.why {
		display: block;
		color: var(--muted);
		font-size: 12px;
		margin-top: 4px;
	}
</style>
