<script lang="ts">
	import type { Project } from '$lib/shared/domain';
	import { CATEGORY_GLYPH, PROJECT_STATUSES } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import { projectHref } from '$lib/client/actions';
	import Avatar from './Avatar.svelte';
	import StatusPill from './StatusPill.svelte';
	import PinButton from './PinButton.svelte';
	import { goto } from '$app/navigation';
	import { fileUrl } from '$lib/client/models';

	let {
		project,
		selecting = false,
		selected = false,
		onselect
	}: {
		project: Project;
		selecting?: boolean;
		selected?: boolean;
		onselect?: (e: MouseEvent) => void;
	} = $props();
	const { lab, ui } = useApp();
	const jobs = $derived(lab.jobsFor(project.id));
	const live = $derived(jobs.some((j) => j.status === 'Printing'));
	const done = $derived(project.checklist.filter((c) => c.done).length);
	const stats = $derived(
		[
			jobs.length ? `${jobs.length} ${jobs.length === 1 ? 'print' : 'prints'}` : '',
			project.checklist.length ? `${done}/${project.checklist.length} steps` : ''
		]
			.filter(Boolean)
			.join(' · ')
	);
	const href = $derived(projectHref(project.id));
	const step = $derived(PROJECT_STATUSES.indexOf(project.status));
	// Background work for this project (AI designs, Blender), live from the event stream.
	const working = $derived(lab.tasksForProject(project.id).filter((t) => t.status === 'running'));
	// The most recently changed model with a thumbnail stands in for the project.
	const cover = $derived.by(() => {
		const models = lab.ws.models
			.filter((m) => m.projectId === project.id)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		for (const m of models) {
			const v = m.versions.find((x) => x.id === m.currentVersionId);
			if (v?.hasThumbnail)
				return { url: fileUrl(m.id, v.id, 'thumbnail.webp'), count: models.length };
		}
		return null;
	});
</script>

<!-- The whole card opens the project; the title link carries keyboard focus and the accessible name. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
	class="project-card idea-card"
	class:pinned={project.pinned}
	data-project={project.id}
	style:view-transition-name="p-{project.id.replace(/[^a-zA-Z0-9_-]/g, '_')}"
	class:selected
	class:selecting
	onclick={(e) => {
		if ((e.target as HTMLElement).closest('button')) return;
		// While selecting (or with Ctrl/⌘/Shift), a click selects instead of opening.
		if (onselect && (selecting || e.ctrlKey || e.metaKey || e.shiftKey)) {
			e.preventDefault();
			onselect(e);
			return;
		}
		if (!(e.target as HTMLElement).closest('a')) goto(href);
	}}
	onpointerenter={() => {
		ui.previewCategory = project.category;
		ui.previewProjectId = project.id;
	}}
	onpointerleave={() => {
		if (ui.previewProjectId === project.id) ui.previewProjectId = null;
	}}
>
	{#if onselect}
		<button
			type="button"
			class="select-box"
			role="checkbox"
			aria-checked={selected}
			aria-label="Select {project.title}"
			onclick={(e) => onselect(e)}
			><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
				><path
					d="M2.5 6.2 5 8.5l4.5-5"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"
				/></svg
			></button
		>
	{/if}
	<div class="card-top">
		<span class="category"
			><span aria-hidden="true">{CATEGORY_GLYPH[project.category]}</span>{project.category}</span
		>
		<span class="card-top-right"
			>{#if working.length}<span
					class="card-task"
					title={working.map((t) => `${t.title}: ${t.stage}`).join('\n')}
					><span class="spin" aria-hidden="true"></span>{working.length === 1
						? working[0].kind.startsWith('ai')
							? 'AI working'
							: 'Blender'
						: `${working.length} tasks`}</span
				>{/if}<PinButton {project} /><StatusPill
				status={project.status}
				label={live ? 'Printing now' : project.status}
				{live}
			/></span
		>
	</div>
	<div class="card-body">
		<div>
			<h2><a {href} onfocus={() => (ui.previewCategory = project.category)}>{project.title}</a></h2>
			<p>{project.description || 'An idea waiting to take shape.'}</p>
		</div>
		{#if cover}
			<span class="card-model" title="{cover.count} {cover.count === 1 ? 'model' : 'models'}"
				><img src={cover.url} alt="" loading="lazy" />{#if cover.count > 1}<b>{cover.count}</b
					>{/if}</span
			>
		{/if}
	</div>
	<div class="card-meta">
		<span class="card-person"
			><Avatar profile={lab.profile(project.profileId)} /><span
				>{lab.profile(project.profileId)?.name}</span
			></span
		>
		{#if stats}<span class="card-stats">{stats}</span>{/if}
	</div>
	<span class="card-progress {project.status}" aria-hidden="true">
		{#each PROJECT_STATUSES as s, n (s)}<i class:on={n <= step}></i>{/each}
	</span>
</article>

<style>
	.select-box {
		position: absolute;
		top: 10px;
		left: 10px;
		z-index: 2;
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border: 1.5px solid var(--line-strong);
		border-radius: 6px;
		background: var(--menu);
		color: transparent;
		opacity: 0;
		transition:
			opacity 0.12s,
			background 0.12s,
			border-color 0.12s;
	}
	:global(.project-card:hover) .select-box,
	.selecting .select-box,
	.select-box:focus-visible {
		opacity: 1;
	}
	.select-box[aria-checked='true'] {
		opacity: 1;
		background: var(--cyan);
		border-color: var(--cyan);
		color: var(--on-accent);
	}
	.selecting .card-top {
		padding-left: 26px;
	}
	/* Shift-click selects a range of cards, not text. */
	.selecting {
		user-select: none;
	}
	.selected {
		border-color: var(--cyan) !important;
		box-shadow:
			0 0 0 1px var(--cyan),
			0 0 0 5px rgb(var(--c1) / 0.14);
	}
	.card-task {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-right: 4px;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 11px;
		color: var(--c2-text);
		background: rgb(var(--c2) / 0.14);
		white-space: nowrap;
	}
	.spin {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		border: 1.5px solid rgb(var(--c2) / 0.3);
		border-top-color: var(--violet);
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
	.card-body {
		display: flex;
		gap: 12px;
		flex: 1;
		min-height: 0;
	}
	.card-body > div {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.card-model {
		position: relative;
		flex-shrink: 0;
		width: 72px;
		height: 54px;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid var(--line);
		background: var(--panel-strong);
		align-self: flex-start;
	}
	.card-model img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.card-model b {
		position: absolute;
		right: 3px;
		bottom: 3px;
		font: 600 10px var(--mono);
		padding: 0 4px;
		border-radius: 999px;
		background: rgb(var(--base) / 0.8);
		color: var(--text);
	}
</style>
