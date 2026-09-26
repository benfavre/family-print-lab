<script lang="ts">
	import { temp } from '$lib/client/format';
	import TempChart from '$lib/components/TempChart.svelte';
	import { SPEED_LABELS } from '$lib/shared/printers/stages';
	import type { PrinterStatus } from '$lib/shared/domain';

	let { printer }: { printer: PrinterStatus } = $props();
	const s = $derived(printer.state ?? null);
	const dual = $derived((s?.nozzles.length ?? 0) > 1);
</script>

<section class="panel">
	<h2 class="panel-title">Temperatures</h2>
	<dl class="facts">
		{#if dual}
			{#each s?.nozzles ?? [] as n (n.id)}
				<div>
					<dt>
						{n.id === 0 ? 'Right nozzle' : 'Left nozzle'}{n.id === s?.activeNozzle
							? ' (in use)'
							: ''}
					</dt>
					<dd>{temp(n.temp, n.target)}</dd>
				</div>
			{/each}
		{:else}
			<div>
				<dt>Nozzle</dt>
				<dd>{temp(s?.nozzle, s?.nozzleTarget)}</dd>
			</div>
		{/if}
		<div>
			<dt>Bed</dt>
			<dd>{temp(s?.bed, s?.bedTarget)}</dd>
		</div>
		<div>
			<dt>Chamber</dt>
			<dd>{temp(s?.chamber, s?.chamberTarget)}</dd>
		</div>
		<div>
			<dt>Speed</dt>
			<dd>
				{SPEED_LABELS[s?.speed.level ?? s?.speedLevel ?? 0] ??
					'—'}{#if s?.speed.magnitude && s.speed.magnitude !== 100}&nbsp;({s.speed.magnitude}%){/if}
			</dd>
		</div>
		{#if s?.stage.name && s.stage.id !== 255 && s.stage.id !== -1}
			<div>
				<dt>Now</dt>
				<dd>{s.stage.name}</dd>
			</div>
		{/if}
	</dl>
	<TempChart {printer} />
</section>
