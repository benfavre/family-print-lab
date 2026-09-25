<script lang="ts">
	import { PROJECT_STATUSES, STATUS_META } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import ProjectCard from '$lib/components/ProjectCard.svelte';
	import PrinterChip from '$lib/components/PrinterChip.svelte';
	import BulkBar from '$lib/components/BulkBar.svelte';
	import type { Project } from '$lib/shared/domain';

	const { lab, ui } = useApp();
	const owned = $derived(lab.ownedProjects(ui.profile));
	const items = $derived(lab.listed(ui));
	const who = $derived(lab.profile(ui.profile));
	const filtered = $derived(!!ui.query.trim() || ui.status !== 'All');

	// ---------- Selecting several projects ----------
	let selectMode = $state(false);
	const selecting = $derived(selectMode || ui.selected.length > 0);
	const visibleIds = $derived(items.map((p) => p.id));
	let anchor: string | null = null;
	function select(p: Project, e: MouseEvent) {
		const ids = visibleIds;
		if (e.shiftKey && anchor && ids.includes(anchor)) {
			// Shift-click: everything between the last clicked card and this one.
			const [a, b] = [ids.indexOf(anchor), ids.indexOf(p.id)].sort((x, y) => x - y);
			ui.selected = [...new Set([...ui.selected, ...ids.slice(a, b + 1)])];
		} else {
			ui.selected = ui.selected.includes(p.id)
				? ui.selected.filter((id) => id !== p.id)
				: [...ui.selected, p.id];
			anchor = p.id;
		}
	}
	function keys(e: KeyboardEvent) {
		if (
			(e.target as HTMLElement).closest('input, textarea, select, [contenteditable]') ||
			document.querySelector('dialog[open]')
		)
			return;
		if (e.key === 'Escape' && selecting) {
			ui.selected = [];
			selectMode = false;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
			e.preventDefault();
			selectMode = true;
			ui.selected = [...visibleIds];
		}
	}
	// Projects deleted elsewhere drop out of the selection.
	$effect(() => {
		const known = new Set(lab.ws.projects.map((p) => p.id));
		if (ui.selected.some((id) => !known.has(id)))
			ui.selected = ui.selected.filter((id) => known.has(id));
	});
</script>

<svelte:head><title>Projects · Family Print Lab</title></svelte:head>
<svelte:window onkeydown={keys} />

<div class="layout">
	<div class="main-col">
		<PageHero
			eyebrow={who ? `${who.name.toUpperCase()}'S WORKBENCH` : 'IDEAS → REAL THINGS'}
			title="What shall we make?"
			text="A little practical. A little playful. Something for everyone."
			note={lab.printer.connected
				? 'Preview animation — see Printer for the live print'
				: 'Preview animation — no printer is connected'}
		>
			{#snippet actions()}
				<button class="primary" onclick={() => ui.openEditor('project')}>＋ New idea</button>
				<button
					class="secondary ai"
					onclick={() => ui.assistantTask?.('ideas', { profileId: ui.profile })}
					>✦ Suggest ideas</button
				>
				<PrinterChip />
			{/snippet}
			{#snippet extra()}
				<StatTiles
					label="Projects by progress"
					items={PROJECT_STATUSES.map((s) => {
						const n = owned.filter((p) => p.status === s).length;
						return { label: s, value: n, p: n / Math.max(owned.length, 1), tone: s };
					})}
				/>
			{/snippet}
		</PageHero>

		<section class="workspace">
			<div class="toolbar">
				<div class="status-tabs" role="group" aria-label="Filter projects by status">
					{#each ['All', ...PROJECT_STATUSES] as const as s (s)}
						<button
							class="status-tab"
							class:selected={ui.status === s}
							aria-pressed={ui.status === s}
							title={s === 'All' ? '' : STATUS_META[s]}
							onclick={() => (ui.status = s)}
						>
							{s === 'All' ? 'All projects' : s}<span
								>{owned.filter((p) => s === 'All' || p.status === s).length}</span
							>
						</button>
					{/each}
				</div>
				<label class="sort-by"
					>Sort <select bind:value={ui.sort} aria-label="Sort projects">
						<option value="updated">Recently changed</option>
						<option value="created">Newest first</option>
						<option value="progress">By progress</option>
						<option value="person">By person</option>
						<option value="name">Name</option>
					</select></label
				>
				<button
					type="button"
					class="secondary select-toggle"
					class:on={selecting}
					aria-pressed={selecting}
					title="Select several projects to change them together (Ctrl+A selects all, Esc clears)"
					onclick={() => {
						if (selecting) {
							ui.selected = [];
							selectMode = false;
						} else selectMode = true;
					}}>{selecting ? 'Exit selection' : 'Select'}</button
				>
				<label class="search"
					><span aria-hidden="true">⌕</span><input
						type="search"
						bind:value={ui.query}
						placeholder="Search projects…"
						aria-label="Search projects"
					/><kbd aria-hidden="true">/</kbd></label
				>
			</div>
			{#if selecting && !ui.selected.length}<div class="section-meta select-hint">
					<span>Click projects to select them · Shift-click for a range · Ctrl+A for all</span>
				</div>{/if}
			{#if filtered}<div class="section-meta">
					<span>{items.length} {items.length === 1 ? 'match' : 'matches'}</span>
				</div>{/if}
			<div class="project-grid">
				{#each items as project (project.id)}
					<ProjectCard
						{project}
						{selecting}
						selected={ui.selected.includes(project.id)}
						onselect={(e) => select(project, e)}
					/>
				{:else}
					<div class="empty">
						<h2>{lab.ws.projects.length ? 'Nothing matches' : 'Room for the next good idea'}</h2>
						<p>
							{lab.ws.projects.length
								? 'Try another filter or search.'
								: 'Add something you would love to print.'}
						</p>
						{#if filtered}<button
								class="secondary"
								onclick={() => ((ui.query = ''), (ui.status = 'All'))}>Clear filters</button
							>{/if}
					</div>
				{/each}
			</div>
		</section>
	</div>
</div>

<BulkBar visible={visibleIds} />

<style>
	.sort-by {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--muted);
	}
	.sort-by select {
		height: 32px;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-md);
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		padding: 0 8px;
		font: inherit;
	}
	.sort-by select option {
		background: var(--menu);
	}
	.select-toggle.on {
		color: var(--on-accent);
		background: var(--cyan);
		box-shadow: none;
	}
	.select-hint span {
		color: var(--cyan);
	}
	/* Room for the selection bar at the bottom. */
	:global(main:has(.bulk-bar)) {
		padding-bottom: 110px;
	}
</style>
