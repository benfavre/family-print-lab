<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { controlTarget, runCommand } from '$lib/client/modules/controls/commands';
	import {
		DETECTOR_LABELS,
		PRINT_OPTION_LABELS,
		detectorReason,
		offlineReason,
		type Detector,
		type HaltSensitivity,
		type PrintOptionName,
		type PrintOptions
	} from '$lib/shared/controls';
	import type { PrinterStatus } from '$lib/shared/domain';

	// The printer's own safety checks: the AI camera checks (xcam) and the print options, each switched
	// on the printer. Only the checks this printer has are listed.
	let { printer }: { printer: PrinterStatus } = $props();
	const app = useApp();
	const t = $derived(controlTarget(printer));
	const s = $derived(printer.state ?? null);
	const offline = $derived(offlineReason(printer));
	let options = $state<PrintOptions | null>(null);
	let busy = $state('');

	onMount(() => {
		const abort = new AbortController();
		fetch(`/api/printers/${printer.id}/print-options`, { signal: abort.signal })
			.then((r) => (r.ok ? r.json() : null))
			.then((o: PrintOptions | null) => (options = o))
			.catch(() => {
				/* offline; the live channel fills it in */
			});
		const off = app.lab.onLive<{ printerId: string; options: PrintOptions }>(
			'controls:options',
			(d) => {
				if (d.printerId === printer.id) options = d.options;
			}
		);
		return () => {
			abort.abort();
			off();
		};
	});

	// Printers with the AI check use it; the X1 series call theirs the spaghetti check.
	const detectors = $derived(
		(
			[
				t.caps.aiMonitoring || s?.xcam.printingMonitor != null
					? 'printing_monitor'
					: 'spaghetti_detector',
				'first_layer_inspector',
				'buildplate_marker_detector'
			] as Detector[]
		).filter((d) => !detectorReason(t, d))
	);
	const detectorOn = (d: Detector) =>
		d === 'printing_monitor'
			? s?.xcam.printingMonitor
			: d === 'spaghetti_detector'
				? s?.xcam.spaghetti
				: d === 'first_layer_inspector'
					? s?.xcam.firstLayer
					: s?.xcam.buildplateMarker;
	const optionList = $derived(
		options
			? (Object.keys(PRINT_OPTION_LABELS) as PrintOptionName[]).filter((k) => options![k].supported)
			: []
	);
	const sensitivity = $derived((s?.xcam.haltSensitivity ?? 'medium') as HaltSensitivity);

	async function run(key: string, name: string, params: Record<string, unknown>) {
		busy = key;
		try {
			await runCommand(app, printer, name, params);
		} finally {
			busy = '';
		}
	}
</script>

<section class="panel">
	<h2 class="panel-title">Print checks</h2>
	{#if offline}<p class="panel-empty">{offline}</p>{/if}
	{#if !detectors.length && !optionList.length}
		<p class="panel-empty">This printer reports no checks the app can switch.</p>
	{/if}
	<ul class="checks">
		{#each detectors as d (d)}
			{@const on = detectorOn(d)}
			<li>
				<label
					><input
						type="checkbox"
						checked={!!on}
						disabled={!!offline || busy === d}
						onchange={(e) =>
							run(d, 'xcam.xcam_control_set', {
								detector: d,
								enabled: e.currentTarget.checked,
								...(d === 'printing_monitor' || d === 'spaghetti_detector' ? { sensitivity } : {})
							})}
					/>
					<span
						><strong>{DETECTOR_LABELS[d].label}</strong><small>{DETECTOR_LABELS[d].help}</small
						></span
					></label
				>
				{#if (d === 'printing_monitor' || d === 'spaghetti_detector') && on}
					<label class="sens"
						>Pause the print at
						<select
							value={sensitivity}
							disabled={!!offline || busy === d}
							onchange={(e) =>
								run(d, 'xcam.xcam_control_set', {
									detector: d,
									enabled: true,
									sensitivity: e.currentTarget.value
								})}
						>
							<option value="low">low</option>
							<option value="medium">medium</option>
							<option value="high">high</option>
						</select>
						sensitivity</label
					>
				{/if}
			</li>
		{/each}
		{#each optionList as k (k)}
			<li>
				<label
					><input
						type="checkbox"
						checked={!!options?.[k].enabled}
						disabled={!!offline || busy === k}
						onchange={(e) =>
							run(k, 'print.print_option', { option: k, enabled: e.currentTarget.checked })}
					/>
					<span
						><strong>{PRINT_OPTION_LABELS[k].label}</strong><small
							>{PRINT_OPTION_LABELS[k].help}</small
						></span
					></label
				>
			</li>
		{/each}
	</ul>
</section>

<style>
	.checks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.checks label {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 13px;
	}
	.checks input[type='checkbox'] {
		margin-top: 3px;
	}
	.checks span {
		display: grid;
	}
	.checks small {
		color: var(--muted);
		font-size: 12px;
	}
	.sens {
		margin: 4px 0 0 24px;
		align-items: center !important;
		color: var(--text-2);
	}
	.sens select {
		padding: 2px 6px;
		border-radius: var(--r-sm);
		border: 1px solid var(--line);
		background: transparent;
	}
</style>
