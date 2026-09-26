<script lang="ts">
	import { hmsCode } from '$lib/client/format';
	import type { PrinterStatus } from '$lib/shared/domain';

	// Error codes as the printer reports them (the hms package replaces this with plain words).
	let { printer }: { printer: PrinterStatus } = $props();
	const s = $derived(printer.state ?? null);
	const errors = $derived([
		...(s?.printError
			? [`Print error ${s.printError.toString(16).toUpperCase().padStart(8, '0')}`]
			: []),
		...(s?.hms ?? []).map((h) => `HMS ${hmsCode(h)}`)
	]);
</script>

<section class="panel">
	<h2 class="panel-title">Alerts</h2>
	{#if errors.length}
		<ul class="alerts">
			{#each errors as e (e)}<li>{e}</li>{/each}
		</ul>
		<p class="panel-empty">Look codes up in Bambu Handy or the Bambu Lab wiki.</p>
	{:else}
		<p class="panel-empty">No errors reported.</p>
	{/if}
	{#if printer.warning}<p class="error">{printer.warning}</p>{/if}
</section>
