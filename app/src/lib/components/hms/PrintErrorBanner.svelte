<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { printerAlerts } from '$lib/client/modules/hms/data';
	import type { HmsAlert } from '$lib/shared/hms';
	import type { PrinterStatus } from '$lib/shared/domain';

	// Shown when the printer's last print failed with an error: what went wrong, in plain words.
	let { printer }: { printer: PrinterStatus } = $props();
	const { lab } = useApp();
	let alert = $state<HmsAlert | null>(null);
	const error = $derived(printer.state?.printError ?? 0);

	$effect(() => {
		const id = printer.id;
		const code = error;
		if (!id || !code) return;
		void printerAlerts(id, { limit: 1 }).then((view) => {
			alert = view?.active.find((a) => a.kind === 'print_error') ?? null;
		});
	});
	const job = $derived(
		printer.state?.task
			? lab.ws.jobs.find(
					(j) =>
						j.status === 'Failed' &&
						j.printerTask === printer.state?.task &&
						(!j.printerId || j.printerId === printer.id)
				)
			: undefined
	);
</script>

{#if alert}
	<section class="panel print-failed" role="status">
		<h2 class="panel-title">The last print failed</h2>
		<p>{alert.text}</p>
		<p class="meta">
			<code>{alert.code}</code>{#if job}&nbsp;· {lab.project(job.projectId)?.title ?? 'Job'} is marked
				Failed{/if}
			{#if alert.wikiUrl}&nbsp;·
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external wiki page -->
				<a href={alert.wikiUrl} target="_blank" rel="noopener noreferrer">Learn more ↗</a>{/if}
		</p>
	</section>
{/if}

<style>
	.print-failed {
		border-color: rgb(var(--c5) / 0.35);
	}
	.print-failed p {
		margin: 0 0 6px;
		font-size: 13.5px;
		color: var(--text);
	}
	.print-failed .meta {
		font-size: 12.5px;
		color: var(--muted);
	}
</style>
