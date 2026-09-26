<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { printerStateLabel } from '$lib/client/format';
	import { PRINTER_MODELS, type ModelCode } from '$lib/shared/printers/models';
	import type { DiscoveredPrinter, PrinterInfo } from '$lib/shared/printers/info';
	import PrinterForm from './PrinterForm.svelte';

	// Settings → Printers: every saved printer, in order, with add, edit, test, switch off, reorder,
	// remove, discovery and diagnostics.
	const { lab, ui } = useApp();
	const printers = $derived(lab.ws.printers ?? []);
	let editing = $state<{ printer: PrinterInfo | null; preset?: Record<string, unknown> } | null>(
		null
	);
	let tests = $state<Record<string, { running: boolean; ok?: boolean; detail?: string }>>({});
	let found = $state<DiscoveredPrinter[] | null>(null);
	let finding = $state(false);
	let findWarning = $state('');
	let dragging = $state<string | null>(null);

	const status = (p: PrinterInfo) => lab.printerById(p.id);
	const certChanged = (p: PrinterInfo) => /certificate changed/.test(status(p)?.error ?? '');

	async function test(p: PrinterInfo) {
		tests[p.id] = { running: true };
		try {
			const r = await fetch('/api/printers/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					id: p.id,
					name: p.name,
					model: p.model,
					host: p.host,
					serial: p.serial,
					port: p.port,
					ftpPort: p.ftpPort,
					tls: p.tls,
					simulated: p.simulated
				})
			});
			const data = await r.json();
			tests[p.id] = { running: false, ok: r.ok && data.ok, detail: data.detail ?? data.error };
		} catch {
			tests[p.id] = { running: false, ok: false, detail: 'Could not reach the app server.' };
		}
	}

	const toggle = (p: PrinterInfo) =>
		lab.call(
			'PATCH',
			`/api/printers/${p.id}`,
			{ version: p.version, enabled: !p.enabled },
			p.enabled ? 'Switched off.' : 'Switched on.'
		);

	async function remove(p: PrinterInfo) {
		if (
			await ui.ask(
				`Remove ${p.name}?`,
				'The app forgets this printer. Print jobs keep their history and can print on any printer.',
				'Remove printer'
			)
		)
			await lab.call('DELETE', `/api/printers/${p.id}`, undefined, 'Printer removed.');
	}

	const trust = (p: PrinterInfo) =>
		lab.call('POST', `/api/printers/${p.id}/trust`, {}, 'The new certificate will be trusted.');

	function reorder(ids: string[]) {
		void lab.call('POST', '/api/printers/reorder', { ids });
	}
	function move(p: PrinterInfo, by: number) {
		const ids = printers.map((x) => x.id);
		const at = ids.indexOf(p.id);
		const to = at + by;
		if (to < 0 || to >= ids.length) return;
		ids.splice(at, 1);
		ids.splice(to, 0, p.id);
		reorder(ids);
	}
	function drop(target: string) {
		if (!dragging || dragging === target) return;
		const ids = printers.map((x) => x.id).filter((id) => id !== dragging);
		ids.splice(ids.indexOf(target), 0, dragging);
		dragging = null;
		reorder(ids);
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

	function addFound(d: DiscoveredPrinter) {
		const model = (d.model ?? 'N6') as ModelCode;
		editing = {
			printer: null,
			preset: {
				name: d.name || PRINTER_MODELS[model].name,
				model,
				host: d.host,
				serial: d.serial
			}
		};
	}
</script>

<section class="int-section" id="printers" aria-label="Printers">
	<div class="section-head">
		<h2>Printers</h2>
		<div class="head-actions">
			<button class="secondary" disabled={finding} onclick={find}
				>{finding ? 'Looking…' : 'Find printers'}</button
			>
			<button class="primary" onclick={() => (editing = { printer: null })}>＋ Add a printer</button
			>
		</div>
	</div>
	<p class="section-lead">
		The app talks to Bambu Lab printers on your home network only. Each one needs <strong
			>LAN Only Mode</strong
		>
		and <strong>Developer Mode</strong> switched on (printer screen: Settings → WLAN / Network), which
		also switches off Bambu's cloud features such as printing from Bambu Handy. Without Developer Mode
		the app can only watch.
	</p>

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
									>{d.model ? PRINTER_MODELS[d.model].short : d.ssdpModel || 'Unknown model'} · {d.host}
									· {d.serial}{d.firmware ? ` · firmware ${d.firmware}` : ''}{d.lanOnly
										? ' · LAN only'
										: ' · LAN Only Mode is off'}</small
								></span
							>
							{#if d.known}<span class="known">Already added</span>{:else}<button
									class="mini primary-mini"
									onclick={() => addFound(d)}>Add</button
								>{/if}
						</li>
					{/each}
				</ul>
			{:else if !findWarning}
				<p class="panel-empty">
					No printers answered. Check they are on and on the same network, or add one by hand.
				</p>
			{/if}
		</div>
	{/if}

	{#if printers.length}
		<ul class="printer-list" aria-label="Saved printers (drag or Alt+arrow keys to reorder)">
			{#each printers as p (p.id)}
				{@const s = status(p)}
				{@const t = tests[p.id]}
				<li
					class:off={!p.enabled}
					class:dragging={dragging === p.id}
					draggable="true"
					ondragstart={() => (dragging = p.id)}
					ondragend={() => (dragging = null)}
					ondragover={(e) => e.preventDefault()}
					ondrop={() => drop(p.id)}
					data-printer={p.id}
				>
					<button
						class="handle"
						aria-label="Move {p.name} (Alt+arrow up or down)"
						title="Drag, or Alt+↑/↓"
						onkeydown={(e) => {
							if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
							e.preventDefault();
							move(p, e.key === 'ArrowUp' ? -1 : 1);
						}}>⋮⋮</button
					>
					<div class="who">
						<b>{p.name}</b>{#if p.id === lab.primaryPrinter?.id}<small class="first">first</small
							>{/if}
						<small
							>{PRINTER_MODELS[p.model]?.short ?? p.model} · {p.host} · {p.serial}{p.simulated
								? ' · simulator'
								: ''}</small
						>
						<small class="state"
							>{s ? printerStateLabel(s) : '—'}{s?.error && !s.connected
								? ` · ${s.error}`
								: ''}</small
						>
						{#if t?.detail}<small class="result" class:bad={!t.ok}
								>{t.ok ? '✓' : '✕'} {t.detail}</small
							>{/if}
					</div>
					<div class="acts">
						<label class="switch" title={p.enabled ? 'Switch off' : 'Switch on'}
							><input
								type="checkbox"
								checked={p.enabled}
								onchange={() => toggle(p)}
								aria-label="{p.name} switched on"
							/></label
						>
						<button class="mini" disabled={t?.running} onclick={() => test(p)}
							>{t?.running ? 'Testing…' : 'Test'}</button
						>
						<button class="mini" onclick={() => (editing = { printer: p })}>Edit</button>
						{#if certChanged(p)}<button class="mini" onclick={() => trust(p)}
								>Trust the new certificate</button
							>{/if}
						{#if s?.connected}<a
								class="mini"
								href={resolve('/api/printers/[id]/diagnostics', { id: p.id })}
								download="printer-{p.model}-diagnostics.json">Download diagnostics</a
							>{/if}
						<button class="mini danger-mini" onclick={() => remove(p)}>Remove</button>
					</div>
				</li>
			{/each}
		</ul>
		<p class="hint">
			The first switched-on printer is the one kid pages and the phone show. Diagnostics hold the
			printer's last report without serial numbers or addresses, for help with a problem.
		</p>
	{:else}
		<ol class="setup">
			<li>
				<strong>On the printer:</strong> Settings → WLAN / Network → turn on <em>LAN Only Mode</em>,
				then <em>Developer Mode</em>. Note the IP address and the 8-character access code.
			</li>
			<li>
				<strong>Find the serial number</strong> in the printer's Settings → Device (also on the label
				at the back).
			</li>
			<li>
				<strong>Press Find printers</strong>, or <strong>Add a printer</strong> and type the details.
				They stay on this computer.
			</li>
			<li>
				<strong>Test the connection</strong>, then save. Until your printer arrives,
				<code>bun run dev:sim</code> runs simulated ones.
			</li>
		</ol>
	{/if}
</section>

{#if editing}
	<PrinterForm printer={editing.printer} preset={editing.preset} onclose={() => (editing = null)} />
{/if}

<style>
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.printer-list {
		list-style: none;
		margin: 12px 0 8px;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.printer-list li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: var(--panel);
	}
	.printer-list li.off {
		opacity: 0.7;
	}
	.printer-list li.dragging {
		border-style: dashed;
	}
	.handle {
		border: 0;
		background: transparent;
		color: var(--dim);
		cursor: grab;
		padding: 4px;
		letter-spacing: -2px;
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
	.who .first {
		display: inline;
		margin-left: 8px;
		color: var(--cyan);
	}
	.who .state {
		color: var(--dim);
	}
	.result {
		color: var(--lime) !important;
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
	.acts a.mini {
		text-decoration: none;
	}
	.switch input {
		width: 16px;
		height: 16px;
	}
	.found ul {
		list-style: none;
		margin: 12px 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.found li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		border: 1px dashed var(--line-strong);
		border-radius: var(--r-md);
		font-size: 13px;
	}
	.found small {
		display: block;
		color: var(--muted);
	}
	.known {
		font-size: 12px;
		color: var(--dim);
	}
	.warn {
		color: var(--amber);
		font-size: 13px;
	}
	.hint {
		font-size: 12px;
		color: var(--dim);
		margin: 0;
	}
	@media (max-width: 700px) {
		.printer-list li {
			grid-template-columns: auto minmax(0, 1fr);
		}
		.acts {
			grid-column: 1 / -1;
			justify-content: flex-start;
		}
	}
</style>
