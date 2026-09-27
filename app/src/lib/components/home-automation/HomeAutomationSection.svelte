<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import {
		PLUG_KIND_NAME,
		type HomeAutomationView,
		type PlugInfo
	} from '$lib/shared/home-automation';
	import type { PrinterInfo } from '$lib/shared/printers/info';
	import PlugForm from './PlugForm.svelte';
	import { plugs, powerLabel } from './plugs.svelte';

	// Integrations → Home automation: a smart plug per printer, MQTT to the family's broker, and read
	// access for Home Assistant and Prometheus. All off until someone turns it on.
	const { lab, ui } = useApp();
	const printers = $derived(lab.ws.printers ?? []);
	let editing = $state<{ printer: PrinterInfo; plug: PlugInfo | null } | null>(null);
	let tests = $state<Record<string, { running: boolean; ok?: boolean; detail?: string }>>({});
	let view = $state<HomeAutomationView | null>(null);
	let token = $state<string | null>(null);
	let mqtt = $state({
		enabled: false,
		url: '',
		username: '',
		password: '',
		topicPrefix: 'printlab',
		discovery: false,
		discoveryPrefix: 'homeassistant',
		verifyTls: true
	});
	let mqttTest = $state<{ running: boolean; ok?: boolean; detail?: string }>({ running: false });
	let savingMqtt = $state(false);
	let failed = $state('');
	const origin = typeof location === 'undefined' ? '' : location.origin;

	function adopt(v: HomeAutomationView) {
		view = v;
		const { hasPassword: _, state: __, ...m } = v.mqtt;
		mqtt = { ...m, password: '' };
	}

	onMount(() => {
		void (async () => {
			try {
				const r = await fetch('/api/ha/settings');
				const v = await r.json().catch(() => ({}));
				if (r.ok) adopt(v as HomeAutomationView);
				else failed = v.error ?? `Could not load the settings (${r.status}).`;
			} catch {
				failed = 'Could not reach the app server. Is it still running?';
			}
		})();
		const offMqtt = lab.onLive<{ state: string }>('home-automation:mqtt', ({ state }) => {
			if (view) view = { ...view, mqtt: { ...view.mqtt, state } };
		});
		const offPlugs = plugs.watch(lab);
		return () => {
			offMqtt();
			offPlugs();
		};
	});

	const where = (p: PlugInfo) =>
		p.kind === 'webhook'
			? 'web addresses'
			: p.kind === 'homeassistant'
				? `${p.config.entityId} on ${p.config.url}`
				: (p.config.url ?? '');

	async function test(p: PlugInfo) {
		tests[p.id] = { running: true };
		const r = await lab.call<{ ok: boolean; detail: string }>(
			'POST',
			`/api/plugs/${p.id}/test`,
			{}
		);
		tests[p.id] = { running: false, ok: r?.ok ?? false, detail: r?.detail ?? 'The test failed.' };
	}

	async function toggle(what: 'ha' | 'metrics', enabled: boolean) {
		const r = await lab.call<{ settings: HomeAutomationView }>(
			'PATCH',
			'/api/ha/settings',
			{ [what]: { enabled } },
			enabled ? 'Switched on.' : 'Switched off.'
		);
		if (r) adopt(r.settings);
	}

	async function saveMqtt(e: SubmitEvent) {
		e.preventDefault();
		savingMqtt = true;
		const { password, ...rest } = mqtt;
		const r = await lab.call<{ settings: HomeAutomationView }>(
			'PATCH',
			'/api/ha/settings',
			{ mqtt: { ...rest, ...(password && { password }) } },
			'MQTT settings saved.'
		);
		savingMqtt = false;
		if (r) adopt(r.settings);
	}

	async function testMqtt() {
		mqttTest = { running: true };
		const { password, ...rest } = mqtt;
		const r = await lab.call<{ ok: boolean; detail: string }>('POST', '/api/ha/mqtt-test', {
			...rest,
			...(password && { password })
		});
		mqttTest = { running: false, ok: r?.ok ?? false, detail: r?.detail ?? 'The test failed.' };
	}

	async function makeToken() {
		if (
			view?.token.hasToken &&
			!(await ui.ask(
				'Make a new token?',
				'The current token stops working. Anything that uses it (Home Assistant, Prometheus) needs the new one.',
				'Make a new token'
			))
		)
			return;
		const r = await lab.call<{ token: string; settings: HomeAutomationView }>(
			'POST',
			'/api/ha/token',
			{}
		);
		if (r) {
			token = r.token;
			adopt(r.settings);
		}
	}

	async function revokeToken() {
		if (
			!(await ui.ask(
				'Stop the token?',
				'Other computers can no longer read the printers. This computer still can.',
				'Stop the token'
			))
		)
			return;
		const r = await lab.call<{ settings: HomeAutomationView }>(
			'DELETE',
			'/api/ha/token',
			undefined,
			'Token stopped.'
		);
		if (r) {
			token = null;
			adopt(r.settings);
		}
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			ui.toast('Copied.');
		} catch {
			ui.toast('Select the text and copy it by hand.', 'error');
		}
	}

	const mqttState = $derived(
		!view?.mqtt.enabled
			? 'Off'
			: view.mqtt.state === 'connected'
				? 'Connected'
				: view.mqtt.state === 'connecting'
					? 'Connecting…'
					: view.mqtt.state === 'off'
						? 'Off'
						: view.mqtt.state
	);
</script>

<section class="int-section" id="home-automation" aria-label="Home automation">
	<h2>Home automation</h2>
	<p class="section-lead">
		Smart plugs switch printers on for a print and off once they have cooled. Home Assistant, an
		MQTT broker or Prometheus can see how the printers are doing. Everything here is off until you
		turn it on, and only talks to devices on your home network that you name.
	</p>

	{#if failed}<p class="result bad" role="alert">{failed}</p>{/if}

	<h3>Smart plugs</h3>
	{#if printers.length && !plugs.loaded}
		<p class="panel-empty">{plugs.error || 'Loading…'}</p>
	{:else if printers.length}
		<ul class="rows" aria-label="Smart plugs">
			{#each printers as printer (printer.id)}
				{@const p = plugs.forPrinter(printer.id)}
				{@const s = plugs.state(printer.id)}
				{@const t = p ? tests[p.id] : undefined}
				<li data-printer={printer.id}>
					<div class="who">
						<b>{printer.name}</b>
						{#if p}
							<small>{PLUG_KIND_NAME[p.kind]} · {where(p)}</small>
							<small class="dim"
								>Power {powerLabel(s).toLowerCase()}{p.autoOn
									? ' · switches on for prints'
									: ''}{p.autoOff ? ` · off after prints below ${p.offBelowNozzle} °C` : ''}{s?.note
									? ` · ${s.note}`
									: ''}</small
							>
							{#if t?.detail}<small class="result" class:bad={!t.ok}
									>{t.ok ? '✓' : '✕'} {t.detail}</small
								>{/if}
						{:else}
							<small class="dim">No smart plug.</small>
						{/if}
					</div>
					<div class="acts">
						{#if p}
							<button class="mini" disabled={t?.running} onclick={() => test(p)}
								>{t?.running ? 'Testing…' : 'Test'}</button
							>
							<button class="mini" onclick={() => (editing = { printer, plug: p })}>Edit</button>
						{:else}
							<button class="mini primary-mini" onclick={() => (editing = { printer, plug: null })}
								>＋ Add a plug</button
							>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
		<p class="hint">
			Works with Tasmota and Shelly plugs on your network, a switch in Home Assistant, or any plug
			with web addresses for on and off. Needs Developer Mode on the printer so the app can send it
			prints.
		</p>
	{:else}
		<p class="panel-empty">Add a printer first, then give it a plug here.</p>
	{/if}

	<h3>MQTT</h3>
	<form class="mqtt" onsubmit={saveMqtt}>
		<label class="toggle"
			><input type="checkbox" bind:checked={mqtt.enabled} /> Send printer status and events to my MQTT
			broker</label
		>
		<div class="fields-row">
			<label class="field"
				>Broker address<input
					bind:value={mqtt.url}
					placeholder="mqtt://192.168.1.10:1883"
					autocomplete="off"
				/><small>mqtts:// for an encrypted connection.</small></label
			>
			<label class="field"
				>Topic prefix<input
					bind:value={mqtt.topicPrefix}
					maxlength="100"
					autocomplete="off"
				/><small
					>Status on {mqtt.topicPrefix || 'printlab'}/&lt;printer&gt;/status, events on {mqtt.topicPrefix ||
						'printlab'}/events/…</small
				></label
			>
		</div>
		<div class="fields-row">
			<label class="field"
				>User name<input bind:value={mqtt.username} maxlength="200" autocomplete="off" /></label
			>
			<label class="field"
				>Password<input
					type="password"
					bind:value={mqtt.password}
					maxlength="500"
					autocomplete="new-password"
					placeholder={view?.mqtt.hasPassword
						? mqtt.url.trim() === view.mqtt.url
							? 'Leave empty to keep'
							: 'Type it again for this broker'
						: ''}
				/></label
			>
		</div>
		<label class="toggle"
			><input type="checkbox" bind:checked={mqtt.discovery} /> Announce the printers to Home Assistant
			(MQTT discovery)</label
		>
		{#if mqtt.url.startsWith('mqtts:')}
			<label class="toggle"
				><input type="checkbox" bind:checked={mqtt.verifyTls} /> Check the broker's certificate</label
			>
		{/if}
		<p class="hint">
			Status: {mqttState}. Messages carry printer names, temperatures and print progress; never
			serial numbers, access codes or addresses.
		</p>
		{#if mqttTest.detail}<p class="result" class:bad={!mqttTest.ok} role="status">
				{mqttTest.ok ? '✓' : '✕'}
				{mqttTest.detail}
			</p>{/if}
		<div class="acts left">
			<button
				type="button"
				class="secondary"
				disabled={mqttTest.running || !mqtt.url}
				onclick={testMqtt}>{mqttTest.running ? 'Testing…' : 'Test the connection'}</button
			>
			<button class="primary" disabled={savingMqtt}>Save MQTT settings</button>
		</div>
	</form>

	<h3>Home Assistant and Prometheus</h3>
	<div class="access">
		<label class="toggle"
			><input
				type="checkbox"
				checked={view?.ha.enabled ?? false}
				disabled={!view}
				onchange={(e) => toggle('ha', e.currentTarget.checked)}
			/> Let Home Assistant read the printers</label
		>
		{#if view?.ha.enabled}<code class="url">{origin}/api/ha/printers</code>{/if}
		<label class="toggle"
			><input
				type="checkbox"
				checked={view?.metrics.enabled ?? false}
				disabled={!view}
				onchange={(e) => toggle('metrics', e.currentTarget.checked)}
			/> Prometheus metrics</label
		>
		{#if view?.metrics.enabled}<code class="url">{origin}/metrics</code>{/if}
		<p class="hint">
			This computer can read them as they are. Other computers need the token below (sent as <code
				>Authorization: Bearer …</code
			>) and this computer's name in <code>ALLOWED_HOSTS</code>.
		</p>
		{#if token}
			<div class="token" role="status">
				<p>Your token. It is shown only now: copy it into Home Assistant or Prometheus.</p>
				<code>{token}</code>
				<button class="mini" onclick={() => copy(token ?? '')}>Copy</button>
			</div>
		{/if}
		<div class="acts left">
			<button class="secondary" disabled={!view} onclick={makeToken}
				>{view?.token.hasToken ? 'Make a new token' : 'Create a token'}</button
			>
			{#if view?.token.hasToken}<button class="mini danger-mini" onclick={revokeToken}
					>Stop the token</button
				>{/if}
		</div>
	</div>
</section>

{#if editing}
	<PlugForm printer={editing.printer} plug={editing.plug} onclose={() => (editing = null)} />
{/if}

<style>
	.int-section {
		margin-bottom: 26px;
		scroll-margin-top: 80px;
	}
	h2 {
		font-size: 15px;
		margin: 0 0 4px;
	}
	h3 {
		font-size: 13px;
		margin: 18px 0 8px;
		color: var(--text-2);
	}
	.section-lead {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
		max-width: 90ch;
	}
	.rows {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.rows li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: var(--panel);
	}
	.who {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.who small {
		color: var(--muted);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.who .dim {
		color: var(--dim);
	}
	.result {
		color: var(--lime) !important;
		font-size: 12.5px;
		margin: 0;
	}
	.result.bad {
		color: var(--err-text) !important;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.acts.left {
		justify-content: flex-start;
	}
	.mqtt,
	.access {
		display: grid;
		gap: 10px;
		max-width: 760px;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-2);
	}
	.hint {
		font-size: 12px;
		color: var(--dim);
		margin: 0;
	}
	.url {
		font-size: 12px;
		margin-left: 24px;
		overflow-wrap: anywhere;
	}
	.token {
		display: grid;
		gap: 6px;
		padding: 10px 12px;
		border: 1px dashed var(--line-strong);
		border-radius: var(--r-md);
		font-size: 13px;
	}
	.token p {
		margin: 0;
		color: var(--amber);
	}
	.token code {
		overflow-wrap: anywhere;
		user-select: all;
	}
	.token .mini {
		justify-self: start;
	}
	@media (max-width: 700px) {
		.rows li {
			grid-template-columns: minmax(0, 1fr);
		}
		.acts {
			justify-content: flex-start;
		}
	}
</style>
