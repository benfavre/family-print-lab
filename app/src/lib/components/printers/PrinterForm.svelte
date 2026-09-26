<script lang="ts">
	import { untrack } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { PRINTER_MODELS, modelsBySeries, type ModelCode } from '$lib/shared/printers/models';
	import type { PrinterInfo } from '$lib/shared/printers/info';

	// Add or edit a printer. The access code is write-only: it is never sent back to the browser.
	let {
		printer = null,
		preset = {},
		onclose
	}: {
		printer?: PrinterInfo | null;
		preset?: Partial<{ name: string; model: ModelCode; host: string; serial: string }>;
		onclose: () => void;
	} = $props();
	const { lab } = useApp();
	const src = untrack(() => ({
		name: '',
		model: 'N6' as ModelCode,
		host: '',
		serial: '',
		port: 8883,
		ftpPort: 990,
		tls: true,
		simulated: false,
		...preset,
		...(printer ?? {})
	}));
	let f = $state({
		name: src.name,
		model: src.model,
		host: src.host,
		serial: src.serial,
		accessCode: '',
		port: src.port,
		ftpPort: src.ftpPort,
		tls: src.tls,
		simulated: src.simulated
	});
	let advanced = $state(false);
	let busy = $state(false);
	let testing = $state(false);
	let result = $state<{ ok: boolean; detail: string; ms: number } | null>(null);
	const groups = modelsBySeries();

	function body() {
		return {
			...f,
			name: f.name.trim() || PRINTER_MODELS[f.model].name,
			port: Number(f.port),
			ftpPort: Number(f.ftpPort)
		};
	}

	async function test() {
		testing = true;
		result = null;
		try {
			const r = await fetch('/api/printers/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...body(), ...(printer && { id: printer.id }) })
			});
			const data = await r.json();
			result = r.ok ? data : { ok: false, ms: 0, detail: data.error ?? 'The test failed.' };
			// The printer said which model it is: take that unless someone chose already.
			if (r.ok && data.model && data.model !== f.model && !printer) f.model = data.model;
		} catch {
			result = { ok: false, ms: 0, detail: 'Could not reach the app server.' };
		} finally {
			testing = false;
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = printer
			? await lab.call(
					'PATCH',
					`/api/printers/${printer.id}`,
					{ ...body(), version: printer.version },
					'Saved.'
				)
			: await lab.call('POST', '/api/printers', body(), 'Printer added.');
		busy = false;
		if (ok) onclose();
	}
</script>

<Modal id="printer-form" {onclose} {busy}>
	<form onsubmit={save}>
		<div class="dialog-top">
			<div>
				<div class="eyebrow">PRINTER</div>
				<h2 id="printer-form-title">{printer ? `Edit ${printer.name}` : 'Add a printer'}</h2>
			</div>
		</div>
		<div class="fields-row">
			<label class="field"
				>Name<input
					bind:value={f.name}
					maxlength="60"
					placeholder={PRINTER_MODELS[f.model].name}
				/></label
			>
			<label class="field"
				>Model<select bind:value={f.model}>
					{#each groups as g (g.series)}
						<optgroup label="{g.series} series">
							{#each g.models as m (m.code)}<option value={m.code}>{m.short}</option>{/each}
						</optgroup>
					{/each}
				</select></label
			>
		</div>
		<div class="fields-row">
			<label class="field"
				>IP address<input
					bind:value={f.host}
					required
					maxlength="253"
					placeholder="192.168.1.20"
					autocomplete="off"
				/><small>On the printer: Settings → WLAN / Network.</small></label
			>
			<label class="field"
				>Serial number<input
					bind:value={f.serial}
					required
					maxlength="32"
					pattern={'[A-Za-z0-9\\-]{4,32}'}
					autocomplete="off"
				/><small>Settings → Device, or the label at the back.</small></label
			>
		</div>
		<label class="field"
			>Access code<input
				bind:value={f.accessCode}
				required={!printer?.hasAccessCode}
				maxlength="8"
				pattern={'[A-Za-z0-9]{8}'}
				autocomplete="off"
				placeholder={printer?.hasAccessCode ? 'Leave empty to keep' : '8 letters or digits'}
			/><small
				>Shown on the printer's screen next to LAN Only Mode. It stays on this computer.</small
			></label
		>
		<button
			type="button"
			class="mini"
			onclick={() => (advanced = !advanced)}
			aria-expanded={advanced}>{advanced ? 'Hide' : 'Show'} advanced settings</button
		>
		{#if advanced}
			<div class="advanced">
				<div class="fields-row">
					<label class="field"
						>MQTT port<input type="number" min="1" max="65535" bind:value={f.port} /></label
					>
					<label class="field"
						>File port<input type="number" min="1" max="65535" bind:value={f.ftpPort} /></label
					>
				</div>
				<label class="toggle"><input type="checkbox" bind:checked={f.tls} /> Encrypted (TLS)</label>
				<label class="toggle"
					><input type="checkbox" bind:checked={f.simulated} /> This is the printer simulator</label
				>
			</div>
		{/if}
		{#if result}
			<p class="result" class:bad={!result.ok} role="status">
				{result.ok ? '✓' : '✕'}
				{result.detail}
			</p>
		{/if}
		<div class="dialog-actions">
			<button
				type="button"
				class="secondary"
				disabled={testing || !f.host || !f.serial}
				onclick={test}>{testing ? 'Testing…' : 'Test the connection'}</button
			>
			<div>
				<button type="button" class="secondary" onclick={onclose}>Cancel</button>
				<button class="primary" disabled={busy}>{printer ? 'Save changes' : 'Add printer'}</button>
			</div>
		</div>
	</form>
</Modal>

<style>
	.advanced {
		margin-top: 12px;
		display: grid;
		gap: 8px;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-2);
	}
	.result {
		margin: 12px 0 0;
		font-size: 13px;
		color: var(--lime);
	}
	.result.bad {
		color: var(--err-text);
	}
</style>
