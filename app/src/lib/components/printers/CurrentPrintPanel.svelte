<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { actions } from '$lib/client/actions';
	import JobCard from '$lib/components/JobCard.svelte';
	import { ACTIVE_PRINTER_STATES, type PrinterStatus } from '$lib/shared/domain';

	// What this printer is printing now: pause, resume, stop, and the job it belongs to.
	let { printer }: { printer: PrinterStatus } = $props();
	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);
	const s = $derived(printer.state ?? null);
	const active = $derived(!!printer.connected && !!s && ACTIVE_PRINTER_STATES.has(s.gcodeState));
	const linked = $derived(
		s?.task
			? lab.ws.jobs.find(
					(j) =>
						j.status === 'Printing' &&
						j.printerTask === s.task &&
						(!j.printerId || j.printerId === printer.id)
				)
			: undefined
	);
	const candidates = $derived(
		lab.ws.jobs.filter(
			(j) =>
				(!j.printerId || j.printerId === printer.id) &&
				(j.status === 'Queued' || (j.status === 'Printing' && !j.printerTask))
		)
	);
	let chosen = $state('');
	/** Clock time the current print should finish, from the printer's remaining time. */
	const doneAt = $derived(
		active && s?.remainingMinutes
			? new Date(ui.now + s.remainingMinutes * 60_000).toLocaleTimeString(undefined, {
					hour: '2-digit',
					minute: '2-digit'
				})
			: ''
	);

	function logNew() {
		const minutes =
			s?.remainingMinutes !== null && s?.remainingMinutes !== undefined && s.percent
				? Math.round(s.remainingMinutes / Math.max(1 - s.percent / 100, 0.01))
				: null;
		ui.openEditor('job', null, {
			status: 'Printing',
			printerTask: s?.task ?? '',
			printerId: printer.id,
			revision: (s?.task ?? '').slice(0, 80),
			minutes,
			startedAt: new Date().toISOString()
		});
	}
</script>

<section class="panel">
	<header class="panel-head">
		<h2>Current print</h2>
		{#if active}<span class="count live-dot"
				>LIVE{#if doneAt}&nbsp;· done around {doneAt}{/if}</span
			>{/if}
	</header>
	{#if active && printer.id}
		<div class="print-controls" role="group" aria-label="Print controls">
			{#if s?.gcodeState === 'PAUSE'}
				<button class="secondary" onclick={() => act.printerControl(printer.id!, 'resume')}
					>▶ Resume</button
				>
			{:else}
				<!-- The printer ignores a pause while it heats and levels, so wait for the print itself. -->
				<button
					class="secondary"
					disabled={s?.gcodeState !== 'RUNNING'}
					title={s?.gcodeState === 'RUNNING'
						? undefined
						: 'Pause is available once the printer starts printing'}
					onclick={() => act.printerControl(printer.id!, 'pause')}>❚❚ Pause</button
				>
			{/if}
			<button class="secondary danger" onclick={() => act.printerControl(printer.id!, 'stop')}
				>■ Stop</button
			>
		</div>
	{/if}
	{#if !active}
		<p class="panel-empty">
			Nothing printing right now. Send a queued job, or start a print from Bambu Studio or the
			printer; it appears here.
		</p>
	{:else if linked}
		<p class="panel-empty">
			Linked to this job. It closes as Succeeded, Failed or Cancelled when the printer finishes. <button
				class="mini"
				onclick={() => act.unlink(linked)}>Unlink</button
			>
		</p>
		<div class="job-list"><JobCard job={linked} now={ui.now} /></div>
	{:else}
		<p class="panel-empty">
			The printer is running <strong>“{s?.task || 'an unnamed print'}”</strong>, which isn't linked
			to a job yet.
		</p>
		{#if candidates.length}
			<div class="link-row">
				<select bind:value={chosen} aria-label="Job to link">
					<option value="" disabled>Choose a job…</option>
					{#each candidates as j (j.id)}<option value={j.id}
							>{lab.project(j.projectId)?.title} · {j.revision || j.status}</option
						>{/each}
				</select>
				<button
					class="mini primary-mini"
					disabled={!chosen}
					onclick={() => {
						const job = lab.ws.jobs.find((j) => j.id === chosen);
						if (job && printer.id) act.linkRunning(job, printer.id);
					}}>Link job</button
				>
			</div>
		{/if}
		<button class="mini" onclick={logNew}>＋ Log it as a new job</button>
	{/if}
</section>

<style>
	.print-controls {
		display: flex;
		gap: 8px;
		margin: 0 0 12px;
	}
	.print-controls .danger {
		color: var(--red);
	}
</style>
