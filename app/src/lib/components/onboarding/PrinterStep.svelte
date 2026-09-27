<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { printerStateLabel } from '$lib/client/format';
	import { trustLine } from '$lib/client/onboarding';
	import { PRINTER_MODELS, modelsBySeries, type ModelCode } from '$lib/shared/printers/models';
	import type { DiscoveredPrinter } from '$lib/shared/printers/info';

	// Setup guide, printer step: what LAN Only Mode and Developer Mode change, finding printers on the
	// network, the access code, a real connection test and adding it. The printer routes do the work
	// (discovery, the TLS check of PLAN 4.2.3, pinning on first use); this only explains and asks.
	const { lab } = useApp();
	const printers = $derived(lab.ws.printers ?? []);
	const groups = modelsBySeries();

	const blank = () => ({
		name: '',
		model: 'N6' as ModelCode,
		host: '',
		serial: '',
		accessCode: '',
		port: 8883,
		ftpPort: 990,
		tls: true,
		simulated: false
	});
	let f = $state(blank());
	let formOpen = $state(false);
	let advanced = $state(false);
	let found = $state<DiscoveredPrinter[] | null>(null);
	let finding = $state(false);
	let findWarning = $state('');
	let testing = $state(false);
	let adding = $state(false);
	let result = $state<{ ok: boolean; detail: string } | null>(null);

	function body() {
		return {
			...f,
			name: f.name.trim() || PRINTER_MODELS[f.model].name,
			host: f.host.trim(),
			serial: f.serial.trim(),
			port: Number(f.port),
			ftpPort: Number(f.ftpPort)
		};
	}

	async function find() {
		finding = true;
		found = null;
		findWarning = '';
		try {
			const r = await fetch('/api/printers/discover', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			});
			const data = await r.json();
			found = r.ok ? data.printers : [];
			findWarning = r.ok ? (data.warning ?? '') : (data.error ?? 'Could not look for printers.');
		} catch {
			found = [];
			findWarning = 'Could not reach the app server.';
		} finally {
			finding = false;
		}
	}

	function choose(d: DiscoveredPrinter) {
		const model = d.model ?? 'N6';
		f = {
			...blank(),
			name: d.name || PRINTER_MODELS[model].name,
			model,
			host: d.host,
			serial: d.serial
		};
		result = null;
		formOpen = true;
	}

	function byHand() {
		f = blank();
		result = null;
		formOpen = true;
	}

	async function test() {
		testing = true;
		result = null;
		try {
			const r = await fetch('/api/printers/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body())
			});
			const data = await r.json();
			result = r.ok ? data : { ok: false, detail: data.error ?? 'The test failed.' };
			// The printer said which model it is.
			if (r.ok && data.model && data.model !== f.model) f.model = data.model;
		} catch {
			result = { ok: false, detail: 'Could not reach the app server.' };
		} finally {
			testing = false;
		}
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		adding = true;
		const res = await lab.call('POST', '/api/printers', body(), 'Printer added.');
		adding = false;
		if (!res) return;
		formOpen = false;
		result = null;
		found = found?.map((d) => (d.serial === f.serial ? { ...d, known: true } : d)) ?? null;
	}

	// Trust is decided on the first connection; fetch the registry again once a new printer connects.
	let refreshed = new Set<string>();
	$effect(() => {
		for (const p of printers) {
			if (p.trust || refreshed.has(p.id) || !lab.printerById(p.id)?.connected) continue;
			refreshed = new Set([...refreshed, p.id]);
			void lab.refresh();
		}
	});
</script>

<div class="step-body">
	<div class="explain" role="note">
		<h3>Before you start: two switches on the printer</h3>
		<p>
			The app talks to your printer directly over your home network, never through the internet. For
			that the printer needs <strong>LAN Only Mode</strong> and <strong>Developer Mode</strong> on (printer
			screen: Settings → WLAN / Network).
		</p>
		<ul>
			<li>
				While LAN Only Mode is on, <strong
					>Bambu Handy and printing through Bambu's cloud stop working</strong
				>. Bambu Studio can still send prints over your network.
			</li>
			<li>
				Without Developer Mode the app can only watch the printer, not start or control prints.
			</li>
			<li>
				To switch back, turn LAN Only Mode off on the same screen. The printer goes back to Bambu's
				cloud and Bambu Handy works again; this app can then only watch it.
			</li>
		</ul>
		<p class="dim">
			The access code is shown on the same screen, next to LAN Only Mode. It stays on this computer.
		</p>
	</div>

	{#if printers.length}
		<ul class="added" aria-label="Printers added">
			{#each printers as p (p.id)}
				{@const s = lab.printerById(p.id)}
				{@const line = trustLine(p)}
				<li data-printer={p.id}>
					<span class="dot" class:on={s?.connected} aria-hidden="true"></span>
					<span class="who">
						<b>{p.name}</b>
						<small
							>{PRINTER_MODELS[p.model].short} · {p.host} · {s?.connected || !s?.error
								? printerStateLabel(s ?? { configured: true })
								: s.error}</small
						>
						{#if line}<small class="trust">{line}</small>{/if}
						{#if s?.connected && s.state?.developerMode === false}
							<small class="warn"
								>Developer Mode is off, so the app can only watch this printer. Turn it on to send
								prints.</small
							>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="row">
		<button class="secondary" disabled={finding} onclick={find}
			>{finding ? 'Looking…' : 'Find printers'}</button
		>
		<button class="secondary" onclick={byHand}>Enter details by hand</button>
	</div>

	{#if found}
		<div class="found" aria-live="polite">
			{#if findWarning}<p class="warn">{findWarning}</p>{/if}
			{#if found.length}
				<ul>
					{#each found as d (d.serial)}
						<li>
							<span
								><b>{d.name || d.serial}</b>
								<small
									>{d.model ? PRINTER_MODELS[d.model].short : d.ssdpModel || 'Unknown model'} · {d.host}{d.lanOnly
										? ' · LAN only'
										: ' · LAN Only Mode is off'}</small
								></span
							>
							{#if d.known}<span class="known">Added</span>{:else}<button
									class="mini primary-mini"
									onclick={() => choose(d)}>Use this one</button
								>{/if}
						</li>
					{/each}
				</ul>
			{:else if !findWarning}
				<p class="dim">
					No printers answered. Check they are on and on the same network, or enter the details by
					hand.
				</p>
			{/if}
		</div>
	{/if}

	{#if formOpen}
		<form class="printer-form" onsubmit={add} aria-label="Printer details">
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
					required
					maxlength="8"
					pattern={'[A-Za-z0-9]{8}'}
					autocomplete="off"
					placeholder="8 letters or digits"
				/><small>Next to LAN Only Mode on the printer's screen.</small></label
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
					<label class="toggle"
						><input type="checkbox" bind:checked={f.tls} /> Encrypted (TLS)</label
					>
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
				{#if result.ok && /trusted on first use/.test(result.detail)}
					<p class="trust">
						The app will remember this printer's certificate and warn you if it ever changes.
					</p>
				{/if}
			{/if}
			<div class="row">
				<button
					type="button"
					class="secondary"
					disabled={testing || !f.host || !f.serial || !f.accessCode}
					onclick={test}>{testing ? 'Testing…' : 'Test the connection'}</button
				>
				<button class="primary" disabled={adding}>Add printer</button>
				<button type="button" class="mini" onclick={() => (formOpen = false)}>Cancel</button>
			</div>
		</form>
	{/if}
</div>

<style>
	.step-body {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.explain {
		padding: 14px 16px;
		border-radius: var(--r-lg);
		border: 1px solid rgb(var(--c4) / 0.35);
		background: rgb(var(--c4) / 0.06);
		font-size: 13px;
		color: var(--text-2);
	}
	.explain h3 {
		margin: 0 0 6px;
		font-size: 14px;
		color: var(--text);
	}
	.explain p {
		margin: 0 0 8px;
	}
	.explain ul {
		margin: 0 0 8px;
		padding-left: 18px;
		display: grid;
		gap: 4px;
	}
	.dim {
		color: var(--dim);
		font-size: 12.5px;
		margin: 0;
	}
	.row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: center;
	}
	.added,
	.found ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.added li,
	.found li {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 12px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: var(--panel);
	}
	.found li {
		align-items: center;
		justify-content: space-between;
	}
	.who,
	.found li > span {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	small {
		font-size: 12px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.dot {
		width: 9px;
		height: 9px;
		margin-top: 5px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--dim);
	}
	.dot.on {
		background: var(--lime);
	}
	.trust {
		color: var(--cyan);
		font-size: 12px;
		margin: 0;
	}
	.warn {
		color: var(--amber);
		margin: 0;
		font-size: 12.5px;
	}
	.known {
		font-size: 12px;
		color: var(--dim);
	}
	.printer-form {
		padding: 14px 16px;
		border-radius: var(--r-lg);
		border: 1px solid var(--line);
		background: var(--panel);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.printer-form > .mini {
		align-self: flex-start;
	}
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
	.printer-form .row {
		margin-top: 12px;
	}
</style>
