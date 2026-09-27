<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { download, projectHref } from '$lib/client/actions';
	import { stamp } from '$lib/client/format';
	import { getSlicerProject, slicerFileUrl } from '$lib/client/slicer-3mf';
	import PageHero from '$lib/components/PageHero.svelte';
	import ProjectOverview from '$lib/components/slicer-3mf/ProjectOverview.svelte';
	import type { SlicerProjectDetail } from '$lib/shared/slicer-3mf';

	const { lab, ui } = useApp();
	const id = $derived(page.params.id!);
	let detail = $state<SlicerProjectDetail | null>(null);
	let problem = $state('');
	const owner = $derived(lab.ws.projects.find((p) => p.id === detail?.projectId));

	async function load(slicerId: string) {
		try {
			detail = await getSlicerProject(slicerId);
			problem = '';
		} catch (e) {
			problem = (e as Error).message;
		}
	}
	$effect(() => void load(id));

	async function rename(name: string) {
		const res = await lab.call<{ slicerProject: SlicerProjectDetail }>(
			'PATCH',
			`/api/slicer-projects/${id}`,
			{ name },
			'Renamed.'
		);
		if (res && detail) detail = { ...detail, name: res.slicerProject.name };
	}

	async function remove() {
		if (!detail) return;
		if (!(await ui.ask(`Delete “${detail.name}”?`, 'The project file goes; your models stay.')))
			return;
		if (await lab.call('DELETE', `/api/slicer-projects/${id}`, undefined, 'Deleted.'))
			await goto(resolve('/slicer-projects'));
	}
</script>

<svelte:head><title>{detail?.name ?? 'Slicer project'} · Family Print Lab</title></svelte:head>

<div class="page">
	<PageHero
		eyebrow={owner ? `SLICER PROJECT · ${owner.title.toUpperCase()}` : 'SLICER PROJECT'}
		title={detail?.name ?? 'Slicer project'}
		text={detail
			? `Saved ${stamp(detail.updatedAt)}. Open it in Bambu Studio or OrcaSlicer to slice and print; everything below comes from the file.`
			: ''}
		note="Preview animation"
		onrename={detail ? rename : undefined}
	>
		{#snippet actions()}
			{#if detail}
				<button class="primary" onclick={() => download(slicerFileUrl(id))}
					>Open in Bambu Studio</button
				>
				{#if owner}<a class="secondary button-link" href={projectHref(owner.id)}>Project</a>{/if}
				<button class="mini danger-mini" onclick={remove}>Delete</button>
			{/if}
		{/snippet}
	</PageHero>

	{#if problem}
		<section class="panel">
			<p class="panel-empty" role="alert">{problem}</p>
			<a href={resolve('/slicer-projects')}>All slicer projects</a>
		</section>
	{:else if !detail}
		<p class="panel-empty">Reading the project file…</p>
	{:else}
		{#if detail.warnings.length}
			<section class="panel warnings" aria-label="Skipped while reading">
				<h2 class="panel-title">Skipped while reading</h2>
				<ul>
					{#each detail.warnings as w, i (i)}<li>{w}</li>{/each}
				</ul>
			</section>
		{/if}
		<ProjectOverview project={detail.project} />
	{/if}
</div>

<style>
	.button-link {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}
	.warnings ul {
		margin: 0;
		padding-left: 18px;
		font-size: 13px;
		color: var(--muted);
	}
</style>
