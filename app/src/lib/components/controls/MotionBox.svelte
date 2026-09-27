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

	// Home, jog pad and extruder, idle only (Bambu Studio's device page layout: X/Y pad, Z, E).
	let { printer, offline }: { printer: PrinterStatus; offline: string | null } = $props();
	const app = useApp();
	const t = $derived(controlTarget(printer));
	const home = $derived(offline ?? homeReason(t));
	let step = $state(10);
	let nozzle = $state<0 | 1>(0);
	let busy = $state(false);
	const steps = $derived(jogSteps(t, 'X'));
	const zStep = $derived(Math.min(step, 10));
	const dual = $derived(dualNozzle(t));
	const extrude = $derived(offline ?? extrudeReason(t, nozzle));

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
				title={jogWhy('Y') ?? `Y +${step} mm`}
				onclick={() => jog('Y', 1)}>Y+</button
			>
			<span></span>
			<button
				class="mini"
				disabled={!!jogWhy('X') || busy}
				title={jogWhy('X') ?? `X −${step} mm`}
				onclick={() => jog('X', -1)}>X−</button
			>
			<button
				class="mini home"
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
				title={jogWhy('X') ?? `X +${step} mm`}
				onclick={() => jog('X', 1)}>X+</button
			>
			<span></span>
			<button
				class="mini"
				disabled={!!jogWhy('Y') || busy}
				title={jogWhy('Y') ?? `Y −${step} mm`}
				onclick={() => jog('Y', -1)}>Y−</button
			>
			<span></span>
		</div>
		<div class="col" role="group" aria-label="Move the bed">
			<button
				class="mini"
				disabled={!!jogWhy('Z') || busy}
				title={jogWhy('Z') ?? `Z +${zStep} mm`}
				onclick={() => jog('Z', 1)}>Z+</button
			>
			<button
				class="mini"
				disabled={!!jogWhy('Z') || busy}
				title={jogWhy('Z') ?? `Z −${zStep} mm`}
				onclick={() => jog('Z', -1)}>Z−</button
			>
		</div>
		<div class="col" role="group" aria-label="Move filament">
			<button
				class="mini"
				disabled={!!extrude || busy}
				title={extrude ?? 'Pull 10 mm of filament back'}
				onclick={() => run('print.set_extrusion_length', { length: -10, ...(dual && { nozzle }) })}
				>Retract</button
			>
			<button
				class="mini"
				disabled={!!extrude || busy}
				title={extrude ?? 'Push 10 mm of filament out'}
				onclick={() => run('print.set_extrusion_length', { length: 10, ...(dual && { nozzle }) })}
				>Extrude</button
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
		{#if dual}
			<div class="seg" role="group" aria-label="Nozzle to extrude with">
				<button aria-pressed={nozzle === 0} onclick={() => (nozzle = 0)}>Right</button>
				<button aria-pressed={nozzle === 1} onclick={() => (nozzle = 1)}>Left</button>
			</div>
		{/if}
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
