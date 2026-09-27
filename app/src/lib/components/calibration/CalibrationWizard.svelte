<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import type { CalibrationData } from '$lib/client/modules/slicer-calibration/store.svelte';
	import {
		CALIB_KINDS,
		CALIB_TESTS,
		calibDefaults,
		calibProblem,
		type CalibKind,
		type CalibParams
	} from '$lib/shared/slicer-calibration';
	import type { PresetSummary } from '$lib/shared/slicer/profiles';
	import TestPicture from './TestPicture.svelte';

	// Starting a calibration test: the printer, the spool (its filament preset is what gets tested and
	// later updated), the test and its range. Print Lab Slicer makes and slices it; the run appears below.
	let { data, printerId: initial = '' }: { data: CalibrationData; printerId?: string } = $props();
	const { lab } = useApp();

	const printers = $derived(lab.printerList.filter((p) => p.id));
	let printerId = $state('');
	let spoolId = $state('');
	let filament = $state('');
	let kind = $state<CalibKind>('flow_rate');
	let params = $state<CalibParams>(calibDefaults('flow_rate'));
	let presets = $state<PresetSummary[]>([]);
	let busy = $state(false);

	$effect(() => {
		if (!printerId || !printers.some((p) => p.id === printerId))
			printerId = printers.find((p) => p.id === initial)?.id ?? printers[0]?.id ?? '';
	});
	const printer = $derived(lab.printerById(printerId));
	const spool = $derived(lab.ws.spools.find((s) => s.id === spoolId) ?? null);
	const material = $derived(spool?.material ?? 'PLA');
	const available = $derived(new Map(data.overview?.tests.map((t) => [t.kind, t]) ?? []));
	const test = $derived(CALIB_TESTS[kind]);
	const problem = $derived(calibProblem(kind, params));
	const why = $derived(available.get(kind)?.reason ?? null);

	// The filament presets that suit the printer's model and nozzle.
	$effect(() => {
		const model = printer?.model;
		const nozzle = printer?.state?.nozzles[0]?.diameter ?? 0.4;
		if (!model) return;
		const q = new URLSearchParams({ kind: 'filament', model, nozzle: String(nozzle) });
		fetch(`/api/slicer/profiles?${q}`)
			.then((r) => (r.ok ? r.json() : []))
			.then((list: PresetSummary[]) => (presets = list.filter((p) => p.instantiable)))
			.catch(() => (presets = []));
	});

	function pick(k: CalibKind) {
		kind = k;
		params = calibDefaults(k, { material });
	}
	// A different material means different temperatures.
	$effect(() => {
		if (kind === 'temp_tower') params = calibDefaults('temp_tower', { material });
	});

	const range = $derived(
		kind === 'pa_line' || kind === 'pa_pattern' || kind === 'pa_tower'
			? { unit: '', step: 0.001 }
			: kind === 'temp_tower'
				? { unit: '°C', step: 5 }
				: kind === 'retraction'
					? { unit: 'mm', step: 0.1 }
					: kind === 'max_volumetric'
						? { unit: 'mm³/s', step: 0.5 }
						: { unit: 'mm/s', step: 5 }
	);

	async function start(e: SubmitEvent) {
		e.preventDefault();
		if (busy || problem || why) return;
		busy = true;
		try {
			const chosen = presets.find((p) => p.id === filament);
			await data.write(
				'POST',
				'/runs',
				{
					kind,
					printerId,
					spoolId: spoolId || null,
					filament: chosen
						? {
								kind: 'filament',
								name: chosen.name,
								source: chosen.source,
								...(chosen.source === 'user' ? { userPresetId: chosen.id } : {})
							}
						: null,
					params: $state.snapshot(params)
				},
				'Making the test. It shows up below when it is sliced.'
			);
		} finally {
			busy = false;
		}
	}
</script>

<section class="panel">
	<h2 class="panel-title">New test</h2>
	{#if !printers.length}
		<p class="panel-empty">Add a printer in Integrations → Printers first.</p>
	{:else}
		<form onsubmit={start}>
			<div class="fields-row">
				<label class="field"
					>Printer<select bind:value={printerId}>
						{#each printers as p (p.id)}<option value={p.id}>{p.name ?? p.modelName}</option>{/each}
					</select></label
				>
				<label class="field"
					>Spool<select bind:value={spoolId}>
						<option value="">No spool</option>
						{#each lab.ws.spools as s (s.id)}
							<option value={s.id}
								>{[s.brand, s.material, s.colorName].filter(Boolean).join(' ')}</option
							>
						{/each}
					</select>
					<small>The result is saved to the filament preset this spool slices with.</small></label
				>
			</div>
			<label class="field"
				>Filament preset<select bind:value={filament}>
					<option value="">{spool ? 'The spool’s own preset' : `The printer’s ${material}`}</option>
					{#each presets as p (p.id)}
						<option value={p.id}>{p.name}{p.source === 'user' ? ' (yours)' : ''}</option>
					{/each}
				</select></label
			>

			<fieldset class="tests">
				<legend>Test</legend>
				{#each CALIB_KINDS as k (k)}
					{@const off = available.get(k)?.reason}
					<label class="test" class:chosen={kind === k} class:off={!!off} title={off ?? ''}>
						<input
							type="radio"
							name="kind"
							value={k}
							checked={kind === k}
							onchange={() => pick(k)}
						/>
						<b>{CALIB_TESTS[k].title}</b>
						<span>{CALIB_TESTS[k].blurb}</span>
					</label>
				{/each}
			</fieldset>

			<div class="detail">
				<TestPicture {kind} label={test.title} />
				<div class="settings">
					{#if kind === 'flow_rate'}
						<div class="fields-row">
							<label class="field"
								>Method<select
									value={params.linear ? 'yolo' : 'classic'}
									onchange={(e) =>
										(params = { ...params, linear: e.currentTarget.value === 'yolo' })}
								>
									<option value="classic">Two passes (Bambu Studio)</option>
									<option value="yolo">YOLO (OrcaSlicer, one print)</option>
								</select></label
							>
							<label class="field"
								>Pass<select
									value={String(params.pass ?? 1)}
									onchange={(e) =>
										(params = { ...params, pass: e.currentTarget.value === '2' ? 2 : 1 })}
								>
									<option value="1">{params.linear ? 'Normal' : 'Pass 1 (coarse)'}</option>
									<option value="2">{params.linear ? 'Perfectionist' : 'Pass 2 (fine)'}</option>
								</select></label
							>
						</div>
						{#if !params.linear && params.pass === 2}
							<p class="hint">
								Save the pass 1 result first: pass 2 starts from the preset’s new flow ratio.
							</p>
						{/if}
					{:else}
						<div class="three">
							<label class="field"
								>Start {range.unit}<input
									type="number"
									step="any"
									bind:value={params.start}
								/></label
							>
							<label class="field"
								>End {range.unit}<input type="number" step="any" bind:value={params.end} /></label
							>
							<label class="field"
								>Step<input
									type="number"
									step="any"
									min={range.step / 10}
									bind:value={params.step}
									disabled={kind === 'temp_tower'}
								/></label
							>
						</div>
						{#if kind === 'pa_line'}
							<label class="toggle"
								><input type="checkbox" bind:checked={params.printNumbers} /> Print the values beside
								the lines</label
							>
						{/if}
					{/if}
					{#if why}<p class="hint warn">{why}</p>
					{:else if problem}<p class="hint warn">{problem}</p>{/if}
					<button class="primary" type="submit" disabled={busy || !!problem || !!why || !printerId}
						>{busy ? 'Starting…' : 'Make the test'}</button
					>
				</div>
			</div>
		</form>
	{/if}
</section>

<style>
	.tests {
		border: 0;
		padding: 0;
		margin: 0 0 12px;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 8px;
	}
	.tests legend {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--muted);
		margin-bottom: 6px;
	}
	.test {
		display: grid;
		gap: 3px;
		padding: 9px 11px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		cursor: pointer;
		font-size: 12.5px;
	}
	.test input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.test b {
		font-size: 13px;
		font-weight: 550;
	}
	.test span {
		color: var(--dim);
		line-height: 1.4;
	}
	.test.chosen {
		border-color: var(--cyan);
		background: rgb(var(--c1) / 0.08);
	}
	.test:focus-within {
		box-shadow: 0 0 0 3px rgb(var(--c1) / 0.15);
	}
	.test.off {
		opacity: 0.55;
	}
	.detail {
		display: grid;
		grid-template-columns: minmax(140px, 220px) 1fr;
		gap: 16px;
		align-items: start;
	}
	.three {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
	}
	.hint {
		color: var(--dim);
		font-size: 12px;
		margin: 0 0 10px;
	}
	.hint.warn {
		color: var(--amber);
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		margin-bottom: 10px;
	}
	@media (max-width: 640px) {
		.detail {
			grid-template-columns: 1fr;
		}
		.three {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
