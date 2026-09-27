<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { hmsCode, hmsKey } from '$lib/client/format';
	import { printerAlerts } from '$lib/client/modules/hms/data';
	import type { HmsAlert as Alert } from '$lib/shared/hms';
	import type { PrinterStatus } from '$lib/shared/domain';
	import HmsAlert from './HmsAlert.svelte';

	// The printer's active alerts in plain words (replaces the foundation's code list).
	let { printer }: { printer: PrinterStatus } = $props();
	const { lab } = useApp();
	let alerts = $state<Alert[]>([]);
	let loaded = $state(false);
	// False when the texts could not be fetched (printer error help off, or the server unreachable):
	// the codes are then shown as the printer reports them, like the basic panel did.
	let described = $state(true);
	// What the printer reports; the list is fetched again whenever it changes.
	const reported = $derived(
		[printer.state?.printError ?? 0, ...(printer.state?.hms ?? []).map(hmsKey)].join('|')
	);
	const rawCodes = $derived([
		...(printer.state?.printError
			? [`Print error ${printer.state.printError.toString(16).toUpperCase().padStart(8, '0')}`]
			: []),
		...(printer.state?.hms ?? []).map((h) => `HMS ${hmsCode(h)}`)
	]);

	let request = 0;
	async function load() {
		if (!printer.id) return;
		const mine = ++request;
		const view = await printerAlerts(printer.id, { limit: 1 });
		if (mine !== request) return;
		described = !!view;
		alerts = view?.active ?? [];
		loaded = true;
	}
	$effect(() => {
		void reported;
		void load();
	});
	$effect(() =>
		lab.onLive<{ printerId: string }>('hms:changed', (d) => {
			if (d.printerId === printer.id) void load();
		})
	);
</script>

<section class="panel">
	<header class="panel-head">
		<h2>Alerts</h2>
		{#if alerts.length}<span class="count">{alerts.length}</span>{/if}
	</header>
	{#if !printer.connected && alerts.length}
		<p class="panel-empty">The printer is offline. These are the last alerts it reported.</p>
	{/if}
	{#if alerts.length}
		<div class="hms-list">
			{#each alerts as a (a.key)}<HmsAlert
					alert={a}
					printerId={printer.connected ? (printer.id ?? null) : null}
					ondone={load}
				/>{/each}
		</div>
	{:else if loaded && !described && rawCodes.length}
		<ul class="alerts">
			{#each rawCodes as e (e)}<li>{e}</li>{/each}
		</ul>
		<p class="panel-empty">
			Couldn't load the descriptions. Look the codes up on the Bambu Lab wiki.
		</p>
	{:else if loaded || !printer.connected}
		<p class="panel-empty">
			{printer.connected ? 'No errors reported.' : 'The printer is offline.'}
		</p>
	{/if}
	{#if printer.warning}<p class="error">{printer.warning}</p>{/if}
	{#if printer.id}
		<a class="mini" href={resolve('/printers/[id]/alerts', { id: printer.id })}>Alert history</a>
	{/if}
</section>

<style>
	.hms-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 10px;
	}
</style>
