<script lang="ts">
	import type { Job } from '$lib/shared/domain';
	import { FINISHED_JOB } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import { actions, projectHref } from '$lib/client/actions';
	import { duration, money, stamp, weight } from '$lib/client/format';
	import { fileUrl, modelHref } from '$lib/client/models';
	import Avatar from './Avatar.svelte';
	import StatusPill from './StatusPill.svelte';

	let {
		job,
		showProject = true,
		now,
		ondragstart,
		ondragend
	}: {
		job: Job;
		showProject?: boolean;
		now: number;
		ondragstart?: () => void;
		ondragend?: () => void;
	} = $props();
	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);
	const project = $derived(lab.project(job.projectId));
	const owner = $derived(lab.profile(project?.profileId));
	const spool = $derived(lab.spool(job.spoolId));
	const specs = $derived(
		[
			job.material || spool?.material,
			job.layerHeight && `${job.layerHeight} mm`,
			job.nozzle && `${job.nozzle} nozzle`,
			job.plate,
			job.infill !== null && `${job.infill}% infill`,
			job.supports !== 'None' && `${job.supports} supports`
		]
			.filter(Boolean)
			.join(' · ')
	);
	const cost = $derived(lab.jobCost(job));
	const figures = $derived(
		[
			FINISHED_JOB.has(job.status) && job.actualMinutes !== null
				? `${duration(job.actualMinutes)} actual`
				: job.minutes !== null
					? `${duration(job.minutes)} est.`
					: '',
			job.grams !== null ? weight(job.grams) : '',
			cost !== null ? `cost ${money(cost)}` : ''
		].filter(Boolean)
	);
	const live = $derived(lab.liveFor(job));
	const progress = $derived(lab.progress(job, now));
	const progressLabel = $derived.by(() => {
		if (live && progress !== null)
			return `Live · ${Math.round(progress * 100)}%${live.layer !== null ? ` · layer ${live.layer}/${live.totalLayers ?? '?'}` : ''}${live.remainingMinutes !== null ? ` · ${duration(live.remainingMinutes)} left` : ''}`;
		if (progress === null)
			return job.startedAt
				? `Started ${stamp(job.startedAt)} · add an estimate to see progress`
				: 'Started';
		return progress >= 1
			? `Estimate reached · started ${stamp(job.startedAt)}`
			: `${Math.round(progress * 100)}% (estimated) · ~${duration((job.minutes ?? 0) * (1 - progress))} left`;
	});
	// The model version this print is of, with its thumbnail.
	const model = $derived.by(() => {
		if (!job.modelVersionId) return null;
		for (const m of lab.ws.models) {
			const v = m.versions.find((x) => x.id === job.modelVersionId);
			if (v) return { m, v };
		}
		return null;
	});
	/** Clock time the print should finish, from live remaining time or the estimate. */
	const eta = $derived.by(() => {
		if (job.status !== 'Printing') return '';
		const remaining =
			live?.remainingMinutes ??
			(progress !== null && job.minutes ? job.minutes * (1 - progress) : null);
		if (remaining === null || remaining <= 0) return '';
		return new Date(now + remaining * 60_000).toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit'
		});
	});
	const when = $derived(
		job.status === 'Queued'
			? `Queued ${stamp(job.createdAt)}`
			: job.status === 'Printing'
				? ''
				: stamp(job.finishedAt)
	);
</script>

<article
	class="job-card"
	class:draggable={!!ondragstart}
	data-job={job.id}
	draggable={ondragstart ? 'true' : undefined}
	ondragstart={(e) => {
		if (!ondragstart) return;
		e.dataTransfer?.setData('text/plain', job.id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
		ondragstart();
	}}
	{ondragend}
>
	<div class="card-top">
		<span class="job-rev"
			>{job.revision || 'Print'}{#if job.printerTask}
				<span class="job-link" title="Linked to printer task {job.printerTask}"
					>· linked to printer</span
				>{/if}</span
		>
		<StatusPill status={job.status} />
	</div>
	{#if (showProject && project) || model}
		<div class="job-head">
			<div class="job-head-text">
				{#if showProject && project}
					<h3><a href={projectHref(project.id)}>{project.title}</a></h3>
					<span class="job-owner"><Avatar profile={owner} />{owner?.name}</span>
				{/if}
				{#if model}<span class="job-model">⬡ {model.m.name} · v{model.v.number}</span>{/if}
			</div>
			{#if model && project}
				<a
					class="job-thumb"
					href={modelHref(project.id, model.m.id)}
					title="Open {model.m.name} in the workbench"
					draggable="false"
				>
					{#if model.v.hasThumbnail}<img
							src={fileUrl(model.m.id, model.v.id, 'thumbnail.png')}
							alt=""
							loading="lazy"
							draggable="false"
						/>{:else}<span aria-hidden="true">⬡</span>{/if}
				</a>
			{/if}
		</div>
	{/if}
	<p class="job-meta">
		<span class="swatch" class:none={!spool} style:--swatch={spool?.colorHex} aria-hidden="true"
		></span><span>{specs || 'No settings recorded'}</span>
	</p>
	{#if figures.length}<p class="job-figures">
			{#each figures as f (f)}<span>{f}</span>{/each}
		</p>{/if}
	{#if job.status === 'Printing'}
		<div class="job-progress" class:live={!!live}>
			<span class="bar" style:--p={progress ?? 0} aria-hidden="true"></span><small
				>{progressLabel}{#if eta}<b class="eta">&nbsp;· done ~{eta}</b>{/if}</small
			>
		</div>
	{/if}
	{#if job.notes}<p class="job-notes">{job.notes}</p>{/if}
	<div class="job-actions">
		{#if job.status === 'Queued'}
			<button class="mini primary-mini" onclick={() => act.transition(job, 'Printing')}
				>Start</button
			>
			<button class="mini" onclick={() => act.transition(job, 'Cancelled')}>Cancel</button>
		{:else if job.status === 'Printing'}
			<button class="mini primary-mini" onclick={() => act.transition(job, 'Succeeded')}
				>Succeeded</button
			>
			<button class="mini danger-mini" onclick={() => act.transition(job, 'Failed')}>Failed</button>
		{:else if job.status === 'Failed'}
			<button class="mini" onclick={() => act.reprint(job)}>Reprint</button>
			<button class="mini ai" onclick={() => ui.assistantTask?.('diagnose', { jobId: job.id })}
				>✦ Diagnose</button
			>
		{:else}
			<button class="mini" onclick={() => act.reprint(job)}
				>{job.status === 'Succeeded' ? 'Print again' : 'Re-queue'}</button
			>
		{/if}
		<span class="job-when">{when}</span>
		<button
			class="mini icon"
			aria-label="Edit print job"
			title="Edit"
			onclick={() => ui.openEditor('job', job.id)}>✎</button
		>
	</div>
</article>

<style>
	.draggable {
		cursor: grab;
	}
	.draggable:active {
		cursor: grabbing;
	}
	:global(.lanes.dragging) .job-card:not(:active) {
		opacity: 0.55;
	}
	.job-head {
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}
	.job-head-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.job-model {
		font-size: 12px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.job-thumb {
		flex-shrink: 0;
		width: 60px;
		height: 45px;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid var(--line);
		background: var(--panel-strong);
		display: grid;
		place-items: center;
		color: var(--dim);
		text-decoration: none;
		transition: border-color 0.15s;
	}
	.job-thumb:hover {
		border-color: rgb(var(--c1) / 0.6);
	}
	.job-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.eta {
		font-weight: 600;
		color: var(--text-2);
	}
</style>
