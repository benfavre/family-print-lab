<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import PrinterCard from '$lib/components/printers/PrinterCard.svelte';

	const { lab } = useApp();
	const list = $derived(lab.printerList);
	const connected = $derived(list.filter((p) => p.connected).length);
	const printing = $derived(list.filter((p) => p.id && lab.printerActiveFor(p.id)));
</script>

<svelte:head><title>Printers · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		<PageHero
			context={{ kind: 'printer' }}
			eyebrow="YOUR PRINTERS"
			title="Printers"
			text="Every printer on your network at a glance: what each one is printing, how far along it is and what filament is loaded."
			progress={printing.length === 1 ? (printing[0].state?.percent ?? 0) / 100 : null}
			note={printing.length
				? 'Live progress from the printer · representative shape'
				: 'Preview animation'}
		>
			{#snippet actions()}
				<a class="secondary button-link" href="{resolve('/integrations')}#printers"
					>Printer settings</a
				>
			{/snippet}
			{#snippet extra()}
				<StatTiles
					label="Printer totals"
					items={[
						{ label: 'Printers', value: list.length, p: 1, tone: 'Planned' },
						{
							label: 'Connected',
							value: connected,
							p: list.length ? connected / list.length : 0,
							tone: 'Done'
						},
						{
							label: 'Printing',
							value: printing.length,
							p: list.length ? printing.length / list.length : 0,
							tone: 'Printing'
						}
					]}
				/>
			{/snippet}
		</PageHero>
		{#if list.length}
			<div class="printer-grid">
				{#each list as p (p.id)}<PrinterCard printer={p} />{/each}
			</div>
		{:else}
			<section class="panel empty-printers">
				<h2 class="panel-title">Connect a printer</h2>
				<p class="panel-empty">
					See live progress, temperatures and AMS filament here, send sliced plates straight to a
					printer, and let print jobs close themselves when it finishes. Everything stays on your
					network: the printer needs LAN Only Mode and Developer Mode switched on.
				</p>
				<a class="primary button-link" href="{resolve('/integrations')}#printers">Add a printer</a>
			</section>
		{/if}
	</div>
</div>

<style>
	.printer-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 12px;
	}
	.button-link {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}
	.empty-printers {
		max-width: 640px;
	}
</style>
