<script lang="ts">
	import { jobErrors } from '$lib/client/modules/hms/data';
	import { SEVERITY_ORDER, displayCode, type HmsEventRow } from '$lib/shared/hms';
	import type { Job } from '$lib/shared/domain';

	// On a failed job's card: the printer error that ended it, in plain words.
	let { job }: { job: Job } = $props();
	let events = $state<HmsEventRow[]>([]);
	$effect(() => {
		const id = job.id;
		void job.status;
		void jobErrors(id).then((list) => (events = list));
	});
	// The print error it failed with; else the worst alert still up when it ended (an alert that was
	// cleared earlier, such as a runout answered mid-print, did not end it).
	const main = $derived(
		events.find((e) => e.kind === 'print_error') ??
			events
				.filter((e) => !e.clearedAt || (job.finishedAt !== null && e.clearedAt >= job.finishedAt))
				.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])[0] ??
			null
	);
</script>

{#if main}
	<p class="job-error">
		<strong>Printer error:</strong>
		{main.text || 'No description for this code yet.'} <code>{displayCode(main.code)}</code>
	</p>
{/if}

<style>
	.job-error {
		margin: 6px 0 0;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--err-text);
	}
	.job-error code {
		font-size: 11px;
	}
</style>
