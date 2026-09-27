<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { stamp } from '$lib/client/format';
	import type { PrinterStatus } from '$lib/shared/domain';
	import type { PrinterInfo } from '$lib/shared/printers/info';
	import { plugs, powerLabel } from './plugs.svelte';

	// The printer page's Power panel: its smart plug's state, on/off by hand (with a confirmation) and
	// the automatic power settings.
	let { printer, info }: { printer: PrinterStatus; info: PrinterInfo } = $props();
	const { lab, ui } = useApp();
	const plug = $derived(plugs.forPrinter(info.id));
	const now = $derived(plugs.state(info.id));
	let busy = $state(false);

	onMount(() => plugs.watch(lab));

	async function power(on: boolean) {
		if (!plug) return;
		const ok = await ui.ask(
			on ? `Switch ${info.name} on?` : `Switch ${info.name} off?`,
			on
				? 'The plug switches on and the printer starts up. It takes about a minute before it reports.'
				: 'The plug cuts the power. The app refuses while a print runs or the nozzle is hot.',
			on ? 'Switch on' : 'Switch off'
		);
		if (!ok) return;
		busy = true;
		await lab.call(
			'POST',
			`/api/plugs/${plug.id}/power`,
			{ on },
			on ? 'Switched on.' : 'Switched off.'
		);
		busy = false;
	}

	async function rule(change: { autoOn?: boolean; autoOff?: boolean }) {
		if (!plug) return;
		busy = true;
		await lab.call('PATCH', `/api/plugs/${plug.id}`, { version: plug.version, ...change });
		// Reloaded either way, so a refused change does not leave the box ticked.
		await plugs.load();
		busy = false;
	}
</script>

<section class="panel">
	<h2 class="panel-title">Power</h2>
	{#if !plugs.loaded && plugs.error}
		<p class="panel-empty">{plugs.error}</p>
		<button class="mini" onclick={() => plugs.load()}>Try again</button>
	{:else if !plugs.loaded}
		<p class="panel-empty">Loading…</p>
	{:else if !plug}
		<p class="panel-empty">
			No smart plug. With one, the app can switch this printer on for a print and off once it has
			cooled.
		</p>
		<a class="mini" href="{resolve('/integrations')}#home-automation">Add a plug</a>
	{:else}
		<dl class="facts one">
			<div>
				<dt>Plug</dt>
				<dd>{powerLabel(now)}{now?.at ? ` · ${stamp(now.at)}` : ''}</dd>
			</div>
		</dl>
		{#if now?.note}<p class="note">{now.note}</p>{/if}
		<div class="acts">
			<button class="mini" disabled={busy || now?.on === true} onclick={() => power(true)}
				>Switch on</button
			>
			<button
				class="mini"
				disabled={busy || printer.printing || now?.on === false}
				title={printer.printing ? 'Not while printing' : undefined}
				onclick={() => power(false)}>Switch off</button
			>
		</div>
		<label class="toggle"
			><input
				type="checkbox"
				checked={plug.autoOn}
				disabled={busy}
				onchange={(e) => rule({ autoOn: e.currentTarget.checked })}
			/> On for prints</label
		>
		<label class="toggle"
			><input
				type="checkbox"
				checked={plug.autoOff}
				disabled={busy}
				onchange={(e) => rule({ autoOff: e.currentTarget.checked })}
			/>
			Off after prints, below {plug.offBelowNozzle} °C</label
		>
		<a class="mini" href="{resolve('/integrations')}#home-automation">Plug settings</a>
	{/if}
</section>

<style>
	.note {
		margin: 6px 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.acts {
		display: flex;
		gap: 6px;
		margin: 8px 0;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-2);
		margin-bottom: 6px;
	}
</style>
