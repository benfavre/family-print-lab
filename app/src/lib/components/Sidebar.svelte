<script lang="ts">
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import { PROJECT_STATUSES, type Project } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import { highlight, matchExcerpt } from '$lib/client/format';
	import { projectHref } from '$lib/client/actions';
	import PinButton from './PinButton.svelte';

	let { currentId }: { currentId: string } = $props();
	const { lab, ui } = useApp();
	let search: HTMLInputElement;
	let list: HTMLElement;

	const items = $derived.by(() => {
		const listed = lab.listed(ui);
		const current = lab.project(currentId);
		return current && !listed.includes(current) && !ui.query ? [current, ...listed] : listed;
	});
	const pinned = $derived(items.filter((p) => p.pinned));
	const rest = $derived(items.filter((p) => !p.pinned));
	const owned = $derived(lab.ownedProjects(ui.profile));
	const sections = $derived(
		[
			{ label: pinned.length ? 'Pinned' : '', list: pinned },
			{ label: pinned.length ? 'Projects' : '', list: rest }
		].filter((s) => s.list.length)
	);

	$effect(() => {
		void currentId;
		tick().then(() => list?.querySelector('.current')?.scrollIntoView({ block: 'nearest' }));
	});

	export function focusSearch() {
		search?.focus();
		search?.select();
	}

	function onSearchKey(e: KeyboardEvent) {
		const first = list.querySelector<HTMLElement>('.side-item');
		if (e.key === 'ArrowDown' && first) {
			e.preventDefault();
			first.focus();
		} else if (e.key === 'Enter' && first) {
			e.preventDefault();
			first.click();
		} else if (e.key === 'Escape' && ui.query) {
			e.preventDefault();
			e.stopPropagation();
			ui.query = '';
		}
	}
	function onListKey(e: KeyboardEvent) {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		const links = [...list.querySelectorAll<HTMLElement>('.side-item')];
		const at = links.indexOf(document.activeElement as HTMLElement);
		if (at < 0) return;
		e.preventDefault();
		if (e.key === 'ArrowUp' && at === 0) return search.focus();
		links[Math.max(0, Math.min(links.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
	}
	const live = (p: Project) => lab.jobsFor(p.id).some((j) => j.status === 'Printing');
</script>

<aside class="sidebar" aria-label="Projects">
	<div class="sidebar-head">
		<a class="crumb" href={resolve('/')}><span aria-hidden="true">←</span> All projects</a>
		<button
			class="icon-button"
			title="New idea (N)"
			aria-label="New idea"
			onclick={() => ui.openEditor('project')}>＋</button
		>
	</div>
	<label class="side-search">
		<span aria-hidden="true">⌕</span>
		<input
			bind:this={search}
			bind:value={ui.query}
			type="search"
			placeholder="Search projects"
			aria-label="Search projects"
			autocomplete="off"
			spellcheck="false"
			onkeydown={onSearchKey}
		/>
		<kbd aria-hidden="true">/</kbd>
	</label>
	<div class="side-filters" role="group" aria-label="Filter by progress">
		{#each ['All', ...PROJECT_STATUSES] as const as s (s)}
			<button
				class="side-filter {s}"
				class:selected={ui.status === s}
				aria-pressed={ui.status === s}
				onclick={() => (ui.status = s)}
			>
				{#if s !== 'All'}<i aria-hidden="true"></i>{/if}{s}<span
					>{owned.filter((p) => s === 'All' || p.status === s).length}</span
				>
			</button>
		{/each}
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="side-scroll" bind:this={list} onkeydown={onListKey}>
		{#each sections as section (section.label)}
			<section class="side-section">
				{#if section.label}<h3>{section.label}<span>{section.list.length}</span></h3>{/if}
				{#each section.list as p (p.id)}
					{@const excerpt = matchExcerpt(p, ui.query)}
					<div
						class="side-row"
						class:current={p.id === currentId}
						class:pinned={p.pinned}
						data-project={p.id}
						style:view-transition-name="p-{p.id.replace(/[^a-zA-Z0-9_-]/g, '_')}"
					>
						<a
							class="side-item {p.status}"
							href={projectHref(p.id)}
							aria-current={p.id === currentId ? 'page' : undefined}
						>
							<span class="side-dot" class:live={live(p)} aria-hidden="true"></span>
							<span class="side-text">
								<span class="side-title"
									>{#each highlight(p.title, ui.query) as seg, i (i)}{#if seg.mark}<mark
												>{seg.text}</mark
											>{:else}{seg.text}{/if}{/each}</span
								>
								<span class="side-sub">
									{#if excerpt}{#each excerpt as seg, i (i)}{#if seg.mark}<mark>{seg.text}</mark
												>{:else}{seg.text}{/if}{/each}{:else}{lab.profile(p.profileId)?.name} · {p.category}{live(
											p
										)
											? ' · printing'
											: ''}{/if}
								</span>
							</span>
						</a>
						<PinButton project={p} />
					</div>
				{/each}
			</section>
		{:else}
			<div class="side-empty">
				<p>No projects match{ui.query ? ` “${ui.query}”` : ' this filter'}.</p>
				<button class="mini" onclick={() => ((ui.query = ''), (ui.status = 'All'))}
					>Clear filters</button
				>
			</div>
		{/each}
	</div>
</aside>
