<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { download, projectHref } from '$lib/client/actions';
	import { stamp } from '$lib/client/format';
	import {
		SLICER_ACCEPT,
		fileSize,
		importSlicerFile,
		listSlicerProjects,
		slicerFileUrl,
		slicerProjectHref
	} from '$lib/client/slicer-3mf';
	import PageHero from '$lib/components/PageHero.svelte';
	import NewFromModels from '$lib/components/slicer-3mf/NewFromModels.svelte';
	import { workspaceHref } from '$lib/client/slicer/api';
	import type { SlicerProjectSummary } from '$lib/shared/slicer-3mf';

	const { lab, ui } = useApp();
	let items = $state<SlicerProjectSummary[] | null>(null);
	let problem = $state('');
	let uploading = $state(false);
	let dragging = $state(false);
	let adding = $state(false);
	let fileInput: HTMLInputElement;

	const projects = $derived([...lab.ws.projects].sort((a, b) => a.title.localeCompare(b.title)));
	let projectId = $state('');
	$effect(() => {
		if (!projectId || !projects.some((p) => p.id === projectId))
			projectId = page.url.searchParams.get('projectId') ?? projects[0]?.id ?? '';
	});
	const groups = $derived(
		projects
			.map((p) => ({ project: p, items: (items ?? []).filter((s) => s.projectId === p.id) }))
			.filter((g) => g.items.length)
	);

	async function load() {
		try {
			items = await listSlicerProjects();
			problem = '';
		} catch (e) {
			problem = (e as Error).message;
		}
	}
	onMount(() => void load());

	async function upload(files: FileList | File[] | null | undefined) {
		const list = [...(files ?? [])];
		if (!list.length) return;
		if (!projectId) return ui.toast('Create a project first.', 'error');
		uploading = true;
		for (const file of list) {
			try {
				const { slicerProject, warnings } = await importSlicerFile(projectId, file);
				ui.toast(
					warnings.length
						? `Imported “${slicerProject.name}” (${warnings.length} thing${warnings.length === 1 ? '' : 's'} skipped).`
						: `Imported “${slicerProject.name}”.`
				);
			} catch (e) {
				ui.toast((e as Error).message, 'error');
			}
		}
		uploading = false;
		await load();
	}

	async function remove(s: SlicerProjectSummary) {
		if (!(await ui.ask(`Delete “${s.name}”?`, 'The project file goes; your models stay.'))) return;
		if (await lab.call('DELETE', `/api/slicer-projects/${s.id}`, undefined, 'Deleted.'))
			await load();
	}
</script>

<svelte:head><title>Slicer projects · Family Print Lab</title></svelte:head>

<div
	class="page"
	role="region"
	aria-label="Slicer projects"
	ondragover={(e) => {
		if (e.dataTransfer?.types.includes('Files')) {
			e.preventDefault();
			dragging = true;
		}
	}}
	ondragleave={(e) => {
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dragging = false;
	}}
	ondrop={(e) => {
		e.preventDefault();
		dragging = false;
		void upload(e.dataTransfer?.files);
	}}
>
	<PageHero
		eyebrow="SLICER PROJECTS"
		title="Slicer projects"
		text="Bambu Studio projects for your prints: plates, parts, modifiers, painting and settings, kept with the project. Import one from Bambu Studio or OrcaSlicer, start one from your models, and open it in Bambu Studio whenever you like."
		note="Preview animation"
	>
		{#snippet actions()}
			<button class="primary" disabled={uploading || !projectId} onclick={() => fileInput.click()}
				>{uploading ? 'Importing…' : '⇪ Import 3MF'}</button
			>
			<button class="secondary" disabled={!projectId} onclick={() => (adding = !adding)}
				>＋ From models</button
			>
		{/snippet}
	</PageHero>
	<input
		bind:this={fileInput}
		type="file"
		accept={SLICER_ACCEPT}
		multiple
		hidden
		onchange={(e) => upload(e.currentTarget.files)}
	/>

	{#if projects.length}
		<section class="panel slicer-bar" aria-label="Where new slicer projects go">
			<label class="for"
				>Imports and new slicer projects go to
				<select bind:value={projectId}>
					{#each projects as p (p.id)}<option value={p.id}>{p.title}</option>{/each}
				</select></label
			>
			{#if adding}
				<NewFromModels {projectId} oncreated={() => (adding = false)} />
			{/if}
		</section>
	{/if}

	{#if problem}
		<p class="panel-empty" role="alert">{problem}</p>
	{:else if !items}
		<p class="panel-empty">Loading…</p>
	{:else if !projects.length}
		<p class="panel-empty">Create a project first: slicer projects belong to one.</p>
	{:else if !groups.length}
		<section class="panel empty">
			<h2 class="panel-title">No slicer projects yet</h2>
			<p class="panel-empty">
				Drop a .3mf from Bambu Studio, OrcaSlicer or PrusaSlicer here, or start one from your
				models. Everything stays on this computer.
			</p>
		</section>
	{:else}
		{#each groups as g (g.project.id)}
			<section class="panel" aria-label={g.project.title}>
				<header class="panel-head">
					<h2><a href={projectHref(g.project.id)}>{g.project.title}</a></h2>
				</header>
				<ul class="slicer-list">
					{#each g.items as s (s.id)}
						<li class="slicer-row" data-slicer-project={s.id}>
							<a class="slicer-name" href={slicerProjectHref(s.id)}>
								<strong>{s.name}</strong>
								<small
									>{s.objects} object{s.objects === 1 ? '' : 's'} · {s.plates}
									plate{s.plates === 1 ? '' : 's'} · {fileSize(s.bytes)} · {stamp(
										s.updatedAt
									)}</small
								>
							</a>
							<span class="row-actions">
								<a class="mini button-link" href={workspaceHref(s.projectId, s.id)}>Slice</a>
								<button class="mini" onclick={() => download(slicerFileUrl(s.id))}
									>Open in Bambu Studio</button
								>
								<button
									class="mini danger-mini"
									onclick={() => remove(s)}
									aria-label="Delete {s.name}">Delete</button
								>
							</span>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
	{#if dragging}<div class="drop-hint">Drop to import</div>{/if}
</div>

<style>
	.page {
		position: relative;
	}
	.button-link {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}
	.slicer-bar {
		display: grid;
		gap: 12px;
		max-width: 640px;
	}
	.for {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		font-size: 13px;
		color: var(--muted);
	}
	.empty {
		max-width: 640px;
	}
	.panel-head a {
		color: inherit;
		text-decoration: none;
	}
	.slicer-list {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.slicer-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
	}
	.slicer-name {
		display: grid;
		gap: 2px;
		flex: 1 1 220px;
		min-width: 0;
		color: inherit;
		text-decoration: none;
	}
	.slicer-name small {
		color: var(--muted);
	}
	.row-actions {
		display: flex;
		gap: 6px;
	}
	.drop-hint {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		background: rgb(var(--base) / 0.75);
		color: var(--cyan);
		font-weight: 550;
		pointer-events: none;
		z-index: 50;
	}
</style>
