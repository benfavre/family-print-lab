<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import PageHero from '$lib/components/PageHero.svelte';
	import PrinterCalibration from '$lib/components/calibration/PrinterCalibration.svelte';

	// One printer's own calibration: its flow dynamics (K-value) profiles and its automatic flow
	// dynamics and flow rate calibration. The printed tests are on the Calibration page.
	const { lab } = useApp();
	const id = $derived(page.params.id ?? '');
	const info = $derived(lab.ws.printers.find((p) => p.id === id));
	const p = $derived(lab.printerById(id));
</script>

<svelte:head><title>Calibration · {info?.name ?? 'Printer'} · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		{#if !info || !p}
			<section class="panel">
				<h2 class="panel-title">That printer is not here</h2>
				<p class="panel-empty">
					It may have been removed in <a href="{resolve('/integrations')}#printers"
						>Integrations → Printers</a
					>.
				</p>
				<a class="mini" href={resolve('/printers')}>All printers</a>
			</section>
		{:else}
			<PageHero
				context={{ kind: 'printer' }}
				eyebrow="CALIBRATION · {p.modelName ?? info.model}"
				title={p.name ?? 'Printer'}
				text="What the printer calibrates itself, and the pressure advance values it keeps for each filament."
				note="Commands as Bambu Studio sends them; tested against the simulator only"
			>
				{#snippet actions()}
					<a
						class="primary button-link"
						href="{resolve('/calibration')}?printer={encodeURIComponent(id)}">Print a test</a
					>
				{/snippet}
			</PageHero>
			<PrinterCalibration printerId={id} />
		{/if}
	</div>
</div>

<style>
	.button-link {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}
	.layout :global(.panel) {
		margin-bottom: 10px;
	}
</style>
