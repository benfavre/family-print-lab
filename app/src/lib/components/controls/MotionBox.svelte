<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { controlTarget, runCommand } from '$lib/client/modules/controls/commands';
	import {
		EXTRUDE_MIN_TEMP,
		dualNozzle,
		extrudeReason,
		homeReason,
		jogReason,
		jogSteps,
		type Axis
	} from '$lib/shared/controls';
	import type { PrinterStatus } from '$lib/shared/domain';

	// Home, jog pad and extruder, idle only (Bambu Studio's device page layout: X/Y pad, Z, E). The
	// arrows send what Studio's do (StatusPanel.cpp on_axis_ctrl_xy: up = Y+, left = X−; on_axis_ctrl_z_up
	// = Z−, down = Z+); the command flips Y and Z on the A-series like Studio, so the arrows keep
	// meaning the same movement on every printer.
	let { printer, offline }: { printer: PrinterStatus; offline: string | null } = $props();
	const app = useApp();
	const t = $derived(controlTarget(printer));
	const home = $derived(offline ?? homeReason(t));
	let step = $state(10);
	let busy = $state(false);
	const steps = $derived(jogSteps(t, 'X'));
	const zStep = $derived(Math.min(step, 10));
	const dual = $derived(dualNozzle(t));
	// Only the nozzle in use moves filament (Bambu Studio on_axis_ctrl_e_*).
	const extrude = $derived(offline ?? extrudeReason(t));
	const inUse = $derived((printer.state?.activeNozzle ?? 0) === 0 ? 'right' : 'left');

	async function run(name: string, params: Record<string, unknown> = {}) {
		busy = true;
		try {
			await runCommand(app, printer, name, params);
		} finally {
			busy = false;
		}
	}
	const jog = (axis: Axis, sign: 1 | -1) => {
		const distance = sign * (axis === 'Z' ? zStep : step);
		return run('print.xyz_ctrl', { axis, distance });
	};
	const jogWhy = (axis: Axis) => offline ?? jogReason(t, axis, axis === 'Z' ? zStep : step);
</script>

<div class="group motion">
	<h3>Move</h3>
	{#if home}<small class="why">{home}</small>{/if}
	<div class="motion-grid">
		<div class="pad" role="group" aria-label="Move the print head">
			<span></span>
			<button
				class="mini"
				disabled={!!jogWhy('Y') || busy}
				aria-label="Up {step} mm"
				title={jogWhy('Y') ?? `Up ${step} mm`}
				onclick={() => jog('Y', 1)}>↑</button
			>
			<span></span>
			<button
				class="mini"
				disabled={!!jogWhy('X') || busy}
				aria-label="Left {step} mm"
				title={jogWhy('X') ?? `Left ${step} mm`}
				onclick={() => jog('X', -1)}>←</button
			>
			<button
				class="mini home"
				aria-label="Home"
				disabled={!!home || busy}
				title={home ?? 'Home all axes'}
				onclick={async () => {
					if (
						await app.ui.ask(
							'Home the printer?',
							'The print head and bed move to their starting positions. Keep hands out of the printer.',
							'Home'
						)
					)
						run('print.back_to_center');
				}}>⌂</button
			>
			<button
				class="mini"
				disabled={!!jogWhy('X') || busy}
				aria-label="Right {step} mm"
				title={jogWhy('X') ?? `Right ${step} mm`}
				onclick={() => jog('X', 1)}>→</button
			>
			<span></span>
			<button
				class="mini"
				disabled={!!jogWhy('Y') || busy}
				aria-label="Down {step} mm"
				title={jogWhy('Y') ?? `Down ${step} mm`}
				onclick={() => jog('Y', -1)}>↓</button
			>
			<span></span>
		</div>
		<div class="col" role="group" aria-label="Move Z">
			<button
				class="mini"
				aria-label="Z up {zStep} mm"
				disabled={!!jogWhy('Z') || busy}
				title={jogWhy('Z') ?? `Z up ${zStep} mm`}
				onclick={() => jog('Z', -1)}>Z ↑</button
			>
			<button
				class="mini"
				aria-label="Z down {zStep} mm"
				disabled={!!jogWhy('Z') || busy}
				title={jogWhy('Z') ?? `Z down ${zStep} mm`}
				onclick={() => jog('Z', 1)}>Z ↓</button
			>
		</div>
		<div class="col" role="group" aria-label="Move filament">
			<button
				class="mini"
				disabled={!!extrude || busy}
				title={extrude ?? `Pull 10 mm of filament back${dual ? ` (${inUse} nozzle)` : ''}`}
				onclick={() => run('print.set_extrusion_length', { length: -10 })}>Retract</button
			>
			<button
				class="mini"
				disabled={!!extrude || busy}
				title={extrude ?? `Push 10 mm of filament out${dual ? ` (${inUse} nozzle)` : ''}`}
				onclick={() => run('print.set_extrusion_length', { length: 10 })}>Extrude</button
			>
		</div>
	</div>
	<div class="row">
		<span class="label">Step</span>
		<div class="seg" role="group" aria-label="Step size">
			{#each steps as s (s)}
				<button aria-pressed={step === s} onclick={() => (step = s)}>{s} mm</button>
			{/each}
		</div>
		{#if dual}<span class="label">Filament moves through the {inUse} nozzle.</span>{/if}
	</div>
	{#if !home && extrude}<small class="why"
			>{extrude === `Heat the nozzle above ${EXTRUDE_MIN_TEMP} °C first.`
				? `Extrude and retract need the nozzle above ${EXTRUDE_MIN_TEMP} °C.`
				: extrude}</small
		>{/if}
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
	.motion-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		align-items: center;
		margin: 6px 0 8px;
	}
	.pad {
		display: grid;
		grid-template-columns: repeat(3, 44px);
		grid-auto-rows: 34px;
		gap: 4px;
	}
	.pad .mini,
	.col .mini {
		justify-content: center;
	}
	.col {
		display: grid;
		gap: 4px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}
	.label {
		font-size: 13px;
		color: var(--text-2);
	}
	.seg {
		display: inline-flex;
		border-radius: var(--r-sm);
		box-shadow: 0 0 0 1px var(--line) inset;
		padding: 2px;
	}
	.seg button {
		border: 0;
		background: transparent;
		color: var(--text-2);
		font-size: 13px;
		padding: 4px 9px;
		border-radius: 6px;
	}
	.seg button[aria-pressed='true'] {
		color: var(--on-accent);
		background: var(--cyan);
	}
	.why {
		display: block;
		color: var(--muted);
		font-size: 12px;
		margin-top: 4px;
	}
</style>
