<script lang="ts">
	import type { PrinterStatus } from '$lib/shared/domain';

	// Firmware as the printer reports it (get_version modules) and whether it offers an update. Read-only:
	// updating is done on the printer or in Bambu Handy.
	let { printer, releaseNotes }: { printer: PrinterStatus; releaseNotes: string | null } = $props();
	const s = $derived(printer.state ?? null);
	const modules = $derived(
		(s?.firmware.modules ?? []).filter((m) => m.sw).sort((a, b) => a.name.localeCompare(b.name))
	);
	// Only names the references settle: ota is the printer firmware (ha-bambulab, report.ts
	// firmwareVersion); ams/, ams_f1/, n3f/ and n3s/ are AMS units by model (ha-bambulab
	// AMSList.info_update). Other boards keep the name the printer gives them.
	const names: Record<string, string> = {
		ota: 'Printer',
		ams: 'AMS',
		ams_f1: 'AMS Lite',
		n3f: 'AMS 2 Pro',
		n3s: 'AMS HT'
	};
	const label = (name: string) => {
		const [base, unit] = name.split('/');
		return names[base] ? `${names[base]}${unit !== undefined ? ` ${unit}` : ''}` : name;
	};
</script>

<section class="panel">
	<h2 class="panel-title">Firmware</h2>
	<dl class="facts one">
		<div>
			<dt>Printer firmware</dt>
			<dd>{s?.firmware.version ?? '—'}</dd>
		</div>
	</dl>
	{#if s?.upgrade.available}
		<p class="update">
			Version {s.upgrade.version ?? 'newer'} is available. Update it from the printer's screen or Bambu
			Handy; this app never installs firmware.
		</p>
	{:else if s}
		<p class="hint">No update offered.</p>
	{/if}
	{#if modules.length}
		<ul class="modules" aria-label="Firmware by part">
			{#each modules as m (m.name + m.serialTail)}
				<li><span>{label(m.name)}</span><code>{m.sw}</code></li>
			{/each}
		</ul>
	{/if}
	{#if releaseNotes}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the Bambu Lab wiki, not an app route -->
		<a class="mini" href={releaseNotes} target="_blank" rel="noopener noreferrer"
			>Release notes on the Bambu Lab wiki</a
		>
	{/if}
</section>

<style>
	.update {
		font-size: 13px;
		color: var(--amber);
		margin: 8px 0;
	}
	.hint {
		color: var(--dim);
		font-size: 12px;
		margin: 8px 0;
	}
	.modules {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		font-size: 12.5px;
	}
	.modules li {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 0;
		border-bottom: 1px solid var(--line);
	}
</style>
