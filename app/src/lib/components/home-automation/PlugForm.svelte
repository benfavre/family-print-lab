<script lang="ts">
	import { untrack } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import {
		PLUG_KINDS,
		PLUG_KIND_NAME,
		type PlugInfo,
		type PlugKind
	} from '$lib/shared/home-automation';
	import type { PrinterInfo } from '$lib/shared/printers/info';
	import { plugs } from './plugs.svelte';

	// Add or edit a printer's smart plug. Passwords and tokens are write-only: never sent back.
	let {
		printer,
		plug = null,
		onclose
	}: { printer: PrinterInfo; plug?: PlugInfo | null; onclose: () => void } = $props();
	const { lab, ui } = useApp();
	const src = untrack(() => plug);
	let f = $state({
		kind: (src?.kind ?? 'tasmota') as PlugKind,
		url: src?.config.url ?? '',
		user: src?.config.user ?? '',
		password: '',
		channel: src?.config.channel ?? 0,
		entityId: src?.config.entityId ?? '',
		token: '',
		onUrl: src?.config.onUrl ?? '',
		offUrl: src?.config.offUrl ?? '',
		method: src?.config.method ?? 'POST',
		autoOn: src?.autoOn ?? true,
		autoOff: src?.autoOff ?? false,
		cooldownMinutes: src?.cooldownMinutes ?? 10,
		offBelowNozzle: src?.offBelowNozzle ?? 50
	});
	let busy = $state(false);
	const saved = (kind: PlugKind) => !!src && src.kind === kind;

	function config() {
		const blank = (s: string) => s.trim() || undefined;
		switch (f.kind) {
			case 'tasmota':
				return { url: blank(f.url), user: blank(f.user), password: f.password || undefined };
			case 'shelly':
				return {
					url: blank(f.url),
					user: blank(f.user),
					password: f.password || undefined,
					channel: Number(f.channel)
				};
			case 'shelly-rpc':
				return { url: blank(f.url), password: f.password || undefined, channel: Number(f.channel) };
			case 'homeassistant':
				return { url: blank(f.url), entityId: blank(f.entityId), token: f.token || undefined };
			case 'webhook':
				return { onUrl: blank(f.onUrl), offUrl: blank(f.offUrl), method: f.method };
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const rules = {
			autoOn: f.autoOn,
			autoOff: f.autoOff,
			cooldownMinutes: Number(f.cooldownMinutes),
			offBelowNozzle: Number(f.offBelowNozzle)
		};
		const ok = src
			? await lab.call(
					'PATCH',
					`/api/plugs/${src.id}`,
					{ version: src.version, kind: f.kind, config: config(), ...rules },
					'Plug saved.'
				)
			: await lab.call(
					'POST',
					'/api/plugs',
					{ printerId: printer.id, kind: f.kind, config: config(), ...rules },
					'Plug added.'
				);
		busy = false;
		if (ok) {
			await plugs.load(lab);
			onclose();
		}
	}

	async function remove() {
		if (!src) return;
		if (
			!(await ui.ask(
				`Remove the plug of ${printer.name}?`,
				'The app stops switching this printer on and off. The plug itself stays as it is.',
				'Remove plug'
			))
		)
			return;
		if (await lab.call('DELETE', `/api/plugs/${src.id}`, undefined, 'Plug removed.')) {
			await plugs.load(lab);
			onclose();
		}
	}
</script>

<Modal id="plug-form" {onclose} {busy}>
	<form onsubmit={save}>
		<div class="dialog-top">
			<div>
				<div class="eyebrow">SMART PLUG</div>
				<h2 id="plug-form-title">{src ? 'Edit' : 'Add'} the plug of {printer.name}</h2>
			</div>
		</div>
		<label class="field"
			>Kind of plug<select bind:value={f.kind}>
				{#each PLUG_KINDS as k (k)}<option value={k}>{PLUG_KIND_NAME[k]}</option>{/each}
			</select></label
		>
		{#if f.kind === 'webhook'}
			<label class="field"
				>Address that switches it on<input
					bind:value={f.onUrl}
					required
					placeholder="http://192.168.1.40/plug/on"
					autocomplete="off"
				/></label
			>
			<label class="field"
				>Address that switches it off<input
					bind:value={f.offUrl}
					required
					placeholder="http://192.168.1.40/plug/off"
					autocomplete="off"
				/></label
			>
			<label class="field"
				>Send as<select bind:value={f.method}>
					<option value="POST">POST</option>
					<option value="GET">GET</option>
				</select><small>The app cannot ask a web address whether the plug is on.</small></label
			>
		{:else}
			<label class="field"
				>{f.kind === 'homeassistant' ? 'Home Assistant address' : 'Address of the plug'}<input
					bind:value={f.url}
					required
					placeholder={f.kind === 'homeassistant'
						? 'http://homeassistant.local:8123'
						: 'http://192.168.1.30'}
					autocomplete="off"
				/></label
			>
		{/if}
		{#if f.kind === 'tasmota' || f.kind === 'shelly'}
			<div class="fields-row">
				<label class="field"
					>User name<input
						bind:value={f.user}
						maxlength="100"
						autocomplete="off"
						placeholder={f.kind === 'tasmota' ? 'admin' : ''}
					/><small>Only if the plug has a login.</small></label
				>
				<label class="field"
					>Password<input
						type="password"
						bind:value={f.password}
						maxlength="500"
						autocomplete="new-password"
						placeholder={saved(f.kind) && src?.config.hasPassword ? 'Leave empty to keep' : ''}
					/></label
				>
			</div>
		{/if}
		{#if f.kind === 'shelly-rpc'}
			<label class="field"
				>Password<input
					type="password"
					bind:value={f.password}
					maxlength="500"
					autocomplete="new-password"
					placeholder={saved(f.kind) && src?.config.hasPassword ? 'Leave empty to keep' : ''}
				/><small>Only if the plug has a login (the user name is always admin).</small></label
			>
		{/if}
		{#if f.kind === 'shelly' || f.kind === 'shelly-rpc'}
			<label class="field"
				>Relay number<input type="number" min="0" max="15" bind:value={f.channel} /><small
					>0 unless the device switches several things.</small
				></label
			>
		{/if}
		{#if f.kind === 'homeassistant'}
			<div class="fields-row">
				<label class="field"
					>Entity<input
						bind:value={f.entityId}
						required
						placeholder="switch.printer_plug"
						autocomplete="off"
					/></label
				>
				<label class="field"
					>Long-lived access token<input
						type="password"
						bind:value={f.token}
						required={!(saved(f.kind) && src?.config.hasToken)}
						maxlength="500"
						autocomplete="off"
						placeholder={saved(f.kind) && src?.config.hasToken ? 'Leave empty to keep' : ''}
					/><small>Home Assistant: your profile → Security → Long-lived access tokens.</small
					></label
				>
			</div>
		{/if}

		<fieldset class="rules">
			<legend>Automatic power</legend>
			<label class="toggle"
				><input type="checkbox" bind:checked={f.autoOn} /> Switch the printer on when a print is sent
				while it is off</label
			>
			<label class="toggle"
				><input type="checkbox" bind:checked={f.autoOff} /> Switch it off after a print, once it has cooled
				down</label
			>
			{#if f.autoOff}
				<div class="fields-row">
					<label class="field"
						>Wait at least (minutes)<input
							type="number"
							min="0"
							max="240"
							bind:value={f.cooldownMinutes}
						/></label
					>
					<label class="field"
						>Nozzle cooler than (°C)<input
							type="number"
							min="30"
							max="120"
							bind:value={f.offBelowNozzle}
						/></label
					>
				</div>
				<p class="hint">
					Power is never cut while a print runs, while the nozzle is hot, or while another print is
					lined up for this printer.
				</p>
			{/if}
		</fieldset>

		<div class="dialog-actions">
			{#if src}<button type="button" class="secondary danger" onclick={remove}>Remove plug</button
				>{:else}<span></span>{/if}
			<div>
				<button type="button" class="secondary" onclick={onclose}>Cancel</button>
				<button class="primary" disabled={busy}>{src ? 'Save changes' : 'Add plug'}</button>
			</div>
		</div>
	</form>
</Modal>

<style>
	.rules {
		margin: 14px 0 0;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		display: grid;
		gap: 8px;
	}
	.rules legend {
		font-size: 12px;
		color: var(--muted);
		padding: 0 4px;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-2);
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--dim);
	}
	.danger {
		color: var(--err-text);
	}
</style>
