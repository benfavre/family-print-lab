<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { controlTarget, runCommand } from '$lib/client/modules/controls/commands';
	import { SPEED_LABELS } from '$lib/shared/printers/stages';
	import {
		AIRDUCT_MODES,
		FAN_LABELS,
		LIGHT_LABELS,
		SPEED_LEVELS,
		airductReason,
		buzzerReason,
		dualNozzle,
		fanReason,
		lightReason,
		offlineReason,
		selectNozzleReason,
		speedReason,
		tempMax,
		tempReason,
		type FanName,
		type LightNode
	} from '$lib/shared/controls';
	import type { PrinterStatus } from '$lib/shared/domain';
	import TempRow from './TempRow.svelte';
	import MotionBox from './MotionBox.svelte';
	import CalibrationBox from './CalibrationBox.svelte';
	import GcodeBox from './GcodeBox.svelte';

	// Everything Bambu Studio's device page controls: speed, lights, temperatures, fans, airduct, the
	// active nozzle and the buzzer, then motion, calibration and custom G-code. Each control is disabled
	// with the reason when the printer lacks it, is busy, or ignores the app (Developer Mode off).
	let { printer }: { printer: PrinterStatus } = $props();
	const app = useApp();
	const t = $derived(controlTarget(printer));
	const s = $derived(printer.state ?? null);
	const offline = $derived(offlineReason(printer));
	let busy = $state('');

	async function run(key: string, name: string, params: Record<string, unknown>, ok?: string) {
		busy = key;
		try {
			await runCommand(app, printer, name, params, ok);
		} finally {
			busy = '';
		}
	}
	const why = (reason: string | null) => offline ?? reason;

	const lights = $derived(
		(['chamber_light', 'work_light', 'chamber_light2', 'heatbed_light'] as LightNode[]).filter(
			(n) => n === 'chamber_light' || n === 'work_light' || !lightReason(t, n)
		)
	);
	const lightMode = (n: LightNode) =>
		({
			chamber_light: s?.lights.chamber,
			chamber_light2: s?.lights.chamber2,
			work_light: s?.lights.work,
			heatbed_light: s?.lights.heatbed
		})[n] ?? null;
	const fans = $derived(
		(['part', 'aux', 'chamber', 'secondaryAux'] as FanName[]).filter(
			(f) => f !== 'secondaryAux' || !fanReason(t, f)
		)
	);
	const dual = $derived(dualNozzle(t));
	const nozzles = $derived(dual ? [0, 1] : [0]);
	const nozzleName = (id: number) =>
		dual ? (id === 0 ? 'Right nozzle' : 'Left nozzle') : 'Nozzle';
	const nozzleNow = (id: number) =>
		dual
			? (s?.nozzles.find((n) => n.id === id) ?? null)
			: { temp: s?.nozzle, target: s?.nozzleTarget };
	const fanSteps = Array.from({ length: 11 }, (_, i) => i * 10);
	let fanDraft = $state<Partial<Record<FanName, number>>>({});
</script>

<section class="panel controls">
	<header class="panel-head">
		<h2>Controls</h2>
		{#if printer.simulated}<span class="count">Simulated</span>{/if}
	</header>
	{#if offline}
		<p class="panel-empty">
			{offline}{#if s?.developerMode === false}
				Turn it on in the printer's network settings, then the controls here work.{/if}
		</p>
	{/if}

	<div class="group">
		<h3>Speed</h3>
		<div class="seg" role="group" aria-label="Print speed">
			{#each SPEED_LEVELS as level (level)}
				<button
					aria-pressed={s?.speed.level === level}
					disabled={!!why(speedReason(t)) || busy === 'speed'}
					title={why(speedReason(t)) ?? undefined}
					onclick={() =>
						run('speed', 'print.print_speed', { level }, `Speed: ${SPEED_LABELS[level]}.`)}
					>{SPEED_LABELS[level]}</button
				>
			{/each}
		</div>
		{#if speedReason(t) && !offline}<small class="why">{speedReason(t)}</small>{/if}
	</div>

	<div class="group">
		<h3>Lights</h3>
		<div class="row">
			{#each lights as node (node)}
				{@const reason = why(lightReason(t, node))}
				{@const on = lightMode(node) === 'on'}
				<button
					class="mini"
					aria-pressed={on}
					disabled={!!reason || busy === node}
					title={reason ?? undefined}
					onclick={() => run(node, 'system.ledctrl', { node, mode: on ? 'off' : 'on' })}
					>{LIGHT_LABELS[node]}: {on
						? 'on'
						: lightMode(node) === 'flashing'
							? 'flashing'
							: 'off'}</button
				>
			{/each}
		</div>
		{#each lights as node (node)}
			{#if lightReason(t, node)}<small class="why">{lightReason(t, node)}</small>{/if}
		{/each}
	</div>

	<div class="group">
		<h3>Temperatures</h3>
		{#each nozzles as id (id)}
			{@const n = nozzleNow(id)}
			<TempRow
				label={nozzleName(id)}
				now={n?.temp}
				target={n?.target}
				max={tempMax(t, 'nozzle')}
				reason={offline ?? tempReason(t, 'nozzle', 0, id)}
				busy={busy === `nozzle${id}`}
				set={(temp) =>
					run(`nozzle${id}`, 'print.set_nozzle_temp', dual ? { temp, nozzle: id } : { temp })}
			/>
		{/each}
		<TempRow
			label="Bed"
			now={s?.bed}
			target={s?.bedTarget}
			max={tempMax(t, 'bed')}
			reason={offline}
			busy={busy === 'bed'}
			set={(temp) => run('bed', 'print.set_bed_temp', { temp })}
		/>
		<TempRow
			label="Chamber"
			now={s?.chamber}
			target={s?.chamberTarget}
			max={tempMax(t, 'chamber')}
			reason={offline ?? tempReason(t, 'chamber', 0)}
			busy={busy === 'chamber'}
			set={async (temp) => {
				// Bambu Studio asks before the airduct switches to heating above 40 °C.
				if (
					t.caps.airductMode &&
					s?.airductMode !== 1 &&
					temp >= 40 &&
					!(await app.ui.ask(
						'Switch to heating mode?',
						'Above 40 °C the printer switches its airduct to heating mode to keep the chamber warm.',
						'Heat the chamber'
					))
				)
					return;
				run('chamber', 'print.set_ctt', { temp });
			}}
		/>
	</div>

	<div class="group">
		<h3>Fans</h3>
		{#each fans as fan (fan)}
			{@const reason = why(fanReason(t, fan))}
			{@const now = s?.fans[fan] ?? null}
			<div class="fan-row" class:off={!!reason}>
				<label for="fan-{fan}-{printer.id}">{FAN_LABELS[fan]}</label>
				<span class="now">{now === null ? '—' : `${now}%`}</span>
				<select
					id="fan-{fan}-{printer.id}"
					disabled={!!reason || busy === fan}
					title={reason ?? undefined}
					value={fanDraft[fan] ?? now ?? 0}
					onchange={(e) => (fanDraft = { ...fanDraft, [fan]: Number(e.currentTarget.value) })}
				>
					{#each fanSteps as step (step)}<option value={step}>{step}%</option>{/each}
				</select>
				<button
					class="mini"
					disabled={!!reason || busy === fan}
					title={reason ?? undefined}
					onclick={() => run(fan, 'print.set_fan', { fan, percent: fanDraft[fan] ?? now ?? 0 })}
					>Set</button
				>
				{#if fanReason(t, fan)}<small class="why">{fanReason(t, fan)}</small>{/if}
			</div>
		{/each}
		{#if !airductReason(t)}
			<div class="row airduct">
				<span class="label">Airflow</span>
				<div class="seg" role="group" aria-label="Airduct mode">
					{#each [0, 1] as mode (mode)}
						<button
							aria-pressed={s?.airductMode === mode}
							disabled={!!offline || busy === 'airduct'}
							onclick={() => run('airduct', 'print.set_airduct', { mode })}
							>{AIRDUCT_MODES[mode]}</button
						>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	{#if t.caps.dualNozzle}
		{@const reason = why(selectNozzleReason(t))}
		<div class="group">
			<h3>Nozzle in use</h3>
			<div class="seg" role="group" aria-label="Nozzle in use">
				{#each [0, 1] as nozzle (nozzle)}
					<button
						aria-pressed={s?.activeNozzle === nozzle}
						disabled={!!reason || busy === 'extruder'}
						title={reason ?? undefined}
						onclick={async () => {
							if (
								await app.ui.ask(
									`Switch to the ${nozzle === 0 ? 'right' : 'left'} nozzle?`,
									'The print head changes over to the other nozzle.',
									'Switch'
								)
							)
								run('extruder', 'print.select_extruder', { nozzle });
						}}>{nozzle === 0 ? 'Right' : 'Left'}</button
					>
				{/each}
			</div>
			{#if selectNozzleReason(t) && !offline}<small class="why">{selectNozzleReason(t)}</small>{/if}
		</div>
	{/if}

	{#if !buzzerReason(t)}
		<div class="group">
			<h3>Alarm buzzer</h3>
			<div class="row">
				{#each [[0, 'Silence'], [2, 'Beep'], [1, 'Alarm']] as [mode, label] (mode)}
					<button
						class="mini"
						disabled={!!offline || busy === 'buzzer'}
						onclick={() => run('buzzer', 'print.buzzer_ctrl', { mode })}>{label}</button
					>
				{/each}
			</div>
		</div>
	{/if}

	<MotionBox {printer} {offline} />
	<CalibrationBox {printer} {offline} />
	<GcodeBox {printer} {offline} />
</section>

<style>
	.controls h3 {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
		margin: 0 0 6px;
	}
	.group {
		padding: 10px 0;
		border-top: 1px solid var(--line);
	}
	.group:first-of-type {
		border-top: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}
	.why {
		display: block;
		color: var(--muted);
		font-size: 12px;
		margin-top: 4px;
	}
	.seg {
		display: inline-flex;
		flex-wrap: wrap;
		border-radius: var(--r-sm);
		box-shadow: 0 0 0 1px var(--line) inset;
		padding: 2px;
	}
	.seg button {
		border: 0;
		background: transparent;
		color: var(--text-2);
		font-size: 13px;
		padding: 5px 10px;
		border-radius: 6px;
	}
	.seg button[aria-pressed='true'] {
		color: var(--on-accent);
		background: var(--cyan);
	}
	.mini[aria-pressed='true'] {
		box-shadow: 0 0 0 1px var(--cyan) inset;
	}
	.fan-row {
		display: grid;
		grid-template-columns: minmax(110px, 1fr) auto auto auto;
		align-items: center;
		gap: 4px 8px;
		padding: 4px 0;
		font-size: 13px;
	}
	.fan-row label {
		color: var(--text-2);
	}
	.fan-row.off label {
		color: var(--muted);
	}
	.fan-row .why {
		grid-column: 1 / -1;
		margin: 0;
	}
	.fan-row select {
		padding: 3px 6px;
		border-radius: var(--r-sm);
		border: 1px solid var(--line);
		background: transparent;
	}
	.now {
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.airduct {
		margin-top: 6px;
	}
	.label {
		font-size: 13px;
		color: var(--text-2);
		margin-right: 6px;
	}
</style>
