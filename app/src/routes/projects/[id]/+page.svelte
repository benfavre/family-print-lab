<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { CATEGORY_GLYPH, CONSUMING_JOB, PROJECT_STATUSES, STATUS_META } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import { actions } from '$lib/client/actions';
	import { duration, money, stamp, weight } from '$lib/client/format';
	import PageHero from '$lib/components/PageHero.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import JobCard from '$lib/components/JobCard.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import ModelsPanel from '$lib/components/ModelsPanel.svelte';
	import SketchesPanel from '$lib/components/SketchesPanel.svelte';

	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);
	const project = $derived(lab.project(page.params.id));
	const jobs = $derived(
		project
			? [...lab.jobsFor(project.id)].sort((a, b) =>
					(b.finishedAt ?? b.startedAt ?? b.createdAt).localeCompare(
						a.finishedAt ?? a.startedAt ?? a.createdAt
					)
				)
			: []
	);
	const owner = $derived(lab.profile(project?.profileId));
	const active = $derived(jobs.find((j) => j.status === 'Printing'));
	const progress = $derived(
		active ? lab.progress(active, ui.now) : project?.status === 'Done' ? 1 : null
	);
	const finishedJobs = $derived(jobs.filter((j) => CONSUMING_JOB.has(j.status)));
	const succeeded = $derived(jobs.filter((j) => j.status === 'Succeeded').length);
	const rate = $derived(finishedJobs.length ? succeeded / finishedJobs.length : null);
	const minutes = $derived(
		finishedJobs.reduce((s, j) => s + (j.actualMinutes ?? j.minutes ?? 0), 0)
	);
	const grams = $derived(finishedJobs.reduce((s, j) => s + (j.grams ?? 0), 0));
	const costs = $derived(
		finishedJobs.map((j) => lab.jobCost(j)).filter((c): c is number => c !== null)
	);
	const done = $derived(project ? project.checklist.filter((c) => c.done).length : 0);
	const files = $derived(
		project
			? project.files
					.split(/\n/)
					.map((f) => f.trim())
					.filter(Boolean)
			: []
	);
	const fullTimeline = $derived(
		project ? lab.ws.activity.filter((a) => a.projectId === project.id) : []
	);
	let showAll = $state(false);
	const timeline = $derived(showAll ? fullTimeline.slice(0, 200) : fullTimeline.slice(0, 6));
	async function rename(title: string) {
		if (!project || !title.trim() || title.trim() === project.title) return;
		await lab.call(
			'PATCH',
			`/api/projects/${project.id}`,
			{ version: project.version, title: title.trim() },
			'Renamed.'
		);
	}
	const step = $derived(project ? PROJECT_STATUSES.indexOf(project.status) : 0);
	let newStep = $state('');
	let stepInput = $state<HTMLInputElement>();

	async function addStep(e: SubmitEvent) {
		e.preventDefault();
		if (!project || !newStep.trim()) return;
		if (await act.addStep(project, newStep.trim())) {
			newStep = '';
			stepInput?.focus();
		}
	}
</script>

<svelte:head><title>{project?.title ?? 'Project'} · Family Print Lab</title></svelte:head>

<div class="layout split">
	<Sidebar currentId={page.params.id ?? ''} />
	<div class="main-col">
		{#if !project}
			<section class="hero">
				<div class="hero-copy">
					<a class="crumb" href={resolve('/')}><span aria-hidden="true">←</span> All projects</a>
					<div class="eyebrow">NOT FOUND</div>
					<h1>This project is gone</h1>
					<p>It may have been deleted in another tab.</p>
				</div>
			</section>
		{:else}
			<PageHero
				crumb
				eyebrow="{CATEGORY_GLYPH[project.category]}  {project.category.toUpperCase()}"
				title={project.title}
				text={project.description || 'An idea waiting to take shape.'}
				focus={project.category}
				{progress}
				onrename={rename}
				context={{ kind: 'project', projectId: project.id }}
				note={active && lab.liveFor(active)
					? 'Live progress from the printer · representative shape'
					: active && progress !== null
						? 'Estimated from start time — not live printer data'
						: `Representative ${project.category.toLowerCase()} shape · add a model to see yours here`}
			>
				{#snippet actions()}
					<button
						class="primary"
						onclick={() => ui.openEditor('job', null, { projectId: project.id })}
						>＋ Queue a print</button
					>
					<button class="secondary" onclick={() => ui.openEditor('project', project.id)}
						>Edit details</button
					>
					<button
						class="secondary pin-toggle"
						class:on={project.pinned}
						aria-pressed={project.pinned}
						onclick={() => act.togglePin(project)}
					>
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
							><path
								fill="currentColor"
								d="M9.8 1.4a1 1 0 0 1 1.4 0l3.4 3.4a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1 .25l-2.2 2.2.3 2.6a1 1 0 0 1-.28.83l-.5.5a.7.7 0 0 1-1 0L6.7 10.8l-3.9 3.9a.6.6 0 0 1-.85-.85l3.9-3.9-2.5-2.5a.7.7 0 0 1 0-1l.5-.5a1 1 0 0 1 .83-.28l2.6.3 2.2-2.2a1 1 0 0 1 .25-1z"
							/></svg
						>
						{project.pinned ? 'Pinned' : 'Pin'}
					</button>
					<button class="secondary" onclick={() => act.duplicate(project)}>Duplicate</button>
					<button
						class="secondary ai"
						onclick={() =>
							ui.assistantAsk?.(
								`Help me with the “${project.title}” project. What should I do next?`
							)}>✦ Ask</button
					>
				{/snippet}
				{#snippet extra()}
					<div class="meta-row">
						<span class="meta-chip"><Avatar profile={owner} />{owner?.name}</span>
						{#if project.material}<span class="meta-chip">◍ {project.material}</span>{/if}
						<span class="meta-chip">Added {stamp(project.createdAt)}</span>
					</div>
					<div class="stepper" role="group" aria-label="Project progress">
						{#each PROJECT_STATUSES as s, n (s)}
							<button
								class={s}
								class:on={n <= step}
								class:current={s === project.status}
								aria-pressed={s === project.status}
								onclick={() => act.setStatus(project, s)}
							>
								<i aria-hidden="true"></i><span>{s}</span><small>{STATUS_META[s]}</small>
							</button>
						{/each}
					</div>
				{/snippet}
			</PageHero>

			<div class="section-meta">
				<span></span><span>Last edited {stamp(project.updatedAt)}</span>
			</div>
			<div class="detail">
				<div class="detail-main">
					<SketchesPanel projectId={project.id} />
					<ModelsPanel projectId={project.id} />
					<section class="panel">
						<header class="panel-head">
							<h2>Print jobs</h2>
							<span class="head-actions">
								<button
									class="mini ai"
									onclick={() => ui.assistantTask?.('settings', { projectId: project.id })}
									>✦ Suggest settings</button
								>
								<button
									class="mini primary-mini"
									onclick={() => ui.openEditor('job', null, { projectId: project.id })}
									>＋ Queue</button
								>
							</span>
						</header>
						{#if jobs.length}
							<div class="job-list">
								{#each jobs as job (job.id)}<JobCard
										{job}
										showProject={false}
										now={ui.now}
									/>{/each}
							</div>
						{:else}
							<p class="panel-empty">
								No prints yet. Queue the first plate when the model is sliced.
							</p>
						{/if}
					</section>
					<section class="panel">
						<header class="panel-head">
							<h2>Measurements & print notes</h2>
							<button class="mini" onclick={() => ui.openEditor('project', project.id)}>Edit</button
							>
						</header>
						{#if project.notes}<p class="prose">{project.notes}</p>{:else}<p class="panel-empty">
								Record fit, measurements and what to change next.
							</p>{/if}
					</section>
					<section class="panel">
						<header class="panel-head">
							<h2>Links & files</h2>
							<button class="mini" onclick={() => ui.openEditor('project', project.id)}>Edit</button
							>
						</header>
						{#if project.url}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external model link typed by the user -->
							<a class="model-link" href={project.url} target="_blank" rel="noopener noreferrer"
								><span aria-hidden="true">⬡</span><span
									><strong>Model reference</strong><small>{project.url}</small></span
								><span aria-hidden="true">↗</span></a
							>
						{:else}
							<p class="panel-empty">
								No link to an online model. Add one (Printables, MakerWorld…) and check its license
								before printing.
							</p>
						{/if}
						{#if files.length}<ul class="files">
								{#each files as f (f)}<li>
										<span aria-hidden="true">▢</span><code>{f}</code>
									</li>{/each}
							</ul>{/if}
					</section>
				</div>
				<aside class="detail-side">
					<section class="panel">
						<h2 class="panel-title">At a glance</h2>
						<dl class="facts">
							<div>
								<dt>Prints</dt>
								<dd>{jobs.length}</dd>
							</div>
							<div>
								<dt>Success</dt>
								<dd>{rate === null ? '—' : `${Math.round(rate * 100)}%`}</dd>
							</div>
							<div>
								<dt>Machine time</dt>
								<dd>{duration(minutes)}</dd>
							</div>
							<div>
								<dt>Filament</dt>
								<dd>{weight(grams)}</dd>
							</div>
							<div>
								<dt>Material cost</dt>
								<dd>{costs.length ? money(costs.reduce((a, b) => a + b, 0)) : '—'}</dd>
							</div>
							<div>
								<dt>Checklist</dt>
								<dd>{project.checklist.length ? `${done}/${project.checklist.length}` : '—'}</dd>
							</div>
						</dl>
					</section>
					<section class="panel">
						<header class="panel-head">
							<h2>Checklist</h2>
							<span class="head-actions">
								{#if project.checklist.length}<span class="count"
										>{Math.round((done / project.checklist.length) * 100)}%</span
									>{/if}
								<button
									class="mini ai"
									onclick={() => ui.assistantTask?.('checklist', { projectId: project.id })}
									>✦ Tailor</button
								>
							</span>
						</header>
						{#if project.checklist.length}
							<div class="meter">
								<span class="bar" style:--p={done / project.checklist.length}></span>
							</div>
							<ul class="checklist">
								{#each project.checklist as c (c.id)}
									<li class:done={c.done}>
										<label
											><input
												type="checkbox"
												checked={c.done}
												onchange={(e) => act.toggleStep(project, c.id, e.currentTarget.checked)}
											/><span>{c.text}</span></label
										>
										<button
											class="mini icon"
											aria-label="Remove step: {c.text}"
											onclick={() => act.removeStep(project, c.id)}>×</button
										>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="panel-empty">Break the build into small steps.</p>
						{/if}
						<form class="add-step" onsubmit={addStep}>
							<input
								bind:this={stepInput}
								bind:value={newStep}
								maxlength="200"
								placeholder="Add a step…"
								aria-label="New checklist step"
							/>
							<button class="mini" disabled={!newStep.trim()}>Add</button>
						</form>
					</section>
					<section class="panel">
						<h2 class="panel-title">Timeline</h2>
						{#if timeline.length}
							<ol class="timeline">
								{#each timeline as e (e.id)}
									<li
										class="t-{/Failed/.test(e.message)
											? 'Failed'
											: /Succeeded|Done/.test(e.message)
												? 'Done'
												: /Started|Printing/.test(e.message)
													? 'Printing'
													: 'Idea'}"
									>
										<span>{e.message}</span><time datetime={e.at}>{stamp(e.at)}</time>
									</li>
								{/each}
							</ol>
							{#if fullTimeline.length > 6}
								<button
									type="button"
									class="mini timeline-more"
									onclick={() => (showAll = !showAll)}
									>{showAll ? 'Show less' : `Show all ${fullTimeline.length}`}</button
								>
							{/if}
						{:else}
							<p class="panel-empty">Activity appears here as you queue and finish prints.</p>
						{/if}
					</section>
				</aside>
			</div>
		{/if}
	</div>
</div>

<style>
	.timeline-more {
		margin-top: 10px;
	}
</style>
