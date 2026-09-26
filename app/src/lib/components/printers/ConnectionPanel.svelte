<script lang="ts">
	import { resolve } from '$app/paths';
	import { stamp } from '$lib/client/format';
	import type { PrinterStatus } from '$lib/shared/domain';
	import type { PrinterInfo } from '$lib/shared/printers/info';

	let { printer, info }: { printer: PrinterStatus; info: PrinterInfo } = $props();
	const s = $derived(printer.state ?? null);
	const trust = $derived(
		!info.tls || info.simulated
			? 'Not encrypted'
			: info.trust === 'ca'
				? 'Certificate verified'
				: info.trust === 'pinned'
					? 'Certificate trusted on first use'
					: '—'
	);
</script>

<section class="panel">
	<h2 class="panel-title">Connection</h2>
	<dl class="facts one">
		<div>
			<dt>Status</dt>
			<dd>
				{printer.enabled === false ? 'Switched off' : printer.connected ? 'Connected' : 'Offline'}
			</dd>
		</div>
		<div>
			<dt>Last report</dt>
			<dd>{stamp(printer.lastSeen) || '—'}</dd>
		</div>
		<div>
			<dt>Model</dt>
			<dd>{printer.modelName ?? info.model}</dd>
		</div>
		<div>
			<dt>Firmware</dt>
			<dd>
				{s?.firmware.version ?? '—'}{#if s?.upgrade.available}&nbsp;· update available{/if}
			</dd>
		</div>
		<div>
			<dt>Security</dt>
			<dd>{trust}</dd>
		</div>
	</dl>
	{#if printer.error && !printer.connected}<p class="panel-empty">{printer.error}</p>{/if}
	<a class="mini" href="{resolve('/integrations')}#printers">Printer settings</a>
</section>
