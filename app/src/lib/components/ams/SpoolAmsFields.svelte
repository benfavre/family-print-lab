<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { amsLinks } from './links.svelte';
	import { trayPlace, type AmsSpool } from '$lib/shared/ams';
	import type { Spool } from '$lib/shared/domain';

	// In the spool editor: where the spool is loaded, its Bambu RFID tag and its Spoolman id. Read
	// only; links are made from the printer's AMS panel.
	let { spool }: { spool: Spool | null } = $props();
	const app = useApp();
	const s = $derived(spool as AmsSpool | null);
	const printers = $derived(app.lab.printerList.filter((p) => p.id));
	// A string, so the effect re-runs only when the set of printers changes (not on every report).
	const ids = $derived(printers.map((p) => p.id!).join(','));
	$effect(() => amsLinks.watch(app, ids ? ids.split(',') : []));
	const link = $derived(s ? amsLinks.whereIs(s.id) : undefined);
	const where = $derived.by(() => {
		if (!link) return '';
		const p = printers.find((x) => x.id === link.printerId);
		return trayPlace(link.tray, {
			printerName: p?.name,
			several: printers.length > 1,
			dual: (p?.state?.nozzles.length ?? 1) > 1
		});
	});
</script>

{#if s && (link || s.rfidUuid || s.rfidTag || s.spoolmanId)}
	<dl class="facts ams-facts">
		{#if link}
			<div>
				<dt>Loaded in</dt>
				<dd>{where}</dd>
			</div>
		{/if}
		{#if s.rfidUuid || s.rfidTag}
			<div>
				<dt>RFID</dt>
				<dd title={s.rfidUuid ?? s.rfidTag ?? ''}>
					Bambu spool{s.bambuInfoIdx ? ` (${s.bambuInfoIdx})` : ''}, recognised by itself
				</dd>
			</div>
		{/if}
		{#if s.spoolmanId}
			<div>
				<dt>Spoolman</dt>
				<dd>Spool #{s.spoolmanId}</dd>
			</div>
		{/if}
	</dl>
{/if}

<style>
	.ams-facts {
		margin-top: 12px;
	}
</style>
