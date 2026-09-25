<script lang="ts">
	import { modelHref } from '$lib/client/models';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { THEMES, useApp } from '$lib/client/app.svelte';
	import { actions, projectHref } from '$lib/client/actions';
	import { weight } from '$lib/client/format';
	import Modal from './Modal.svelte';

	const app = useApp();
	const { lab, ui } = app;
	let q = $state('');
	let index = $state(0);

	interface Item {
		label: string;
		hint: string;
		run: () => unknown;
	}
	const source = $derived.by((): Item[] => {
		const act = actions(app);
		const current = page.params.id ? lab.project(page.params.id) : undefined;
		return [
			{ label: 'Projects', hint: 'Go to', run: () => goto(resolve('/')) },
			{ label: 'Print jobs', hint: 'Go to', run: () => goto(resolve('/jobs')) },
			{ label: 'Printer (live)', hint: 'Go to', run: () => goto(resolve('/printer')) },
			{ label: 'Filament shelf', hint: 'Go to', run: () => goto(resolve('/filament')) },
			{ label: 'Family', hint: 'Go to', run: () => goto(resolve('/family')) },
			{
				label: 'Integrations (Claude, ChatGPT, Blender, printer)',
				hint: 'Go to',
				run: () => goto(resolve('/integrations'))
			},
			{ label: 'Keyboard shortcuts', hint: 'Help', run: () => (ui.shortcutsOpen = true) },
			{ label: 'New idea', hint: 'Action', run: () => ui.openEditor('project') },
			{
				label: 'Queue a print',
				hint: 'Action',
				run: () => ui.openEditor('job', null, current ? { projectId: current.id } : {})
			},
			{ label: 'Add spool', hint: 'Action', run: () => ui.openEditor('spool') },
			{ label: 'Add person', hint: 'Action', run: () => ui.openEditor('profile') },
			...(current
				? [
						{
							label: current.pinned ? 'Unpin this project' : 'Pin this project',
							hint: 'Action',
							run: () => act.togglePin(current)
						}
					]
				: []),
			{ label: 'Ask the lab assistant', hint: 'AI', run: () => ui.assistantAsk?.('') },
			{
				label: 'Suggest print ideas',
				hint: 'AI',
				run: () => ui.assistantTask?.('ideas', { profileId: ui.profile })
			},
			{ label: 'Export backup (JSON)', hint: 'Data', run: () => act.exportBackup() },
			{ label: 'Save database snapshot', hint: 'Data', run: () => act.snapshotNow() },
			...THEMES.map(([id, name]) => ({
				label: `Theme: ${name}`,
				hint: 'Appearance',
				run: () => ui.setTheme(id)
			})),
			...lab.ws.projects.map((p) => ({
				label: p.title,
				hint: `${p.category} · ${p.status}${p.pinned ? ' · pinned' : ''}`,
				run: () => goto(projectHref(p.id))
			})),
			...lab.ws.models.map((m) => ({
				label: m.name,
				hint: `Model · ${lab.project(m.projectId)?.title ?? ''}`,
				run: () => goto(modelHref(m.projectId, m.id))
			})),
			...lab.ws.spools.map((s) => ({
				label: `${s.colorName || s.colorHex} ${s.material}`,
				hint: `Spool · ${weight(s.remainingGrams)} left`,
				run: () => ui.openEditor('spool', s.id)
			}))
		];
	});
	const items = $derived(
		source
			.filter((i) => `${i.label} ${i.hint}`.toLowerCase().includes(q.trim().toLowerCase()))
			.slice(0, 12)
	);

	function close() {
		ui.paletteOpen = false;
		q = '';
		index = 0;
	}
	function run(i: number) {
		const item = items[i];
		if (!item) return;
		close();
		item.run();
	}
	function keys(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1);
			document.getElementById(`pal-${index}`)?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter') {
			e.preventDefault();
			run(index);
		}
	}
</script>

{#if ui.paletteOpen}
	<Modal id="palette" onclose={close}>
		<h2 id="palette-title" class="visually-hidden">Search and commands</h2>
		<div class="palette-search">
			<span aria-hidden="true">⌕</span>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:value={q}
				oninput={() => (index = 0)}
				onkeydown={keys}
				autofocus
				type="search"
				placeholder="Jump to a project, view or action…"
				aria-label="Search projects, views and actions"
				autocomplete="off"
				role="combobox"
				aria-controls="palette-list"
				aria-expanded="true"
				aria-activedescendant={items.length ? `pal-${index}` : undefined}
			/>
			<kbd>Esc</kbd>
		</div>
		<ul id="palette-list" role="listbox">
			{#each items as item, i (item.hint + item.label + i)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					role="option"
					id="pal-{i}"
					aria-selected={i === index}
					onclick={() => run(i)}
					onpointermove={() => (index = i)}
				>
					<span>{item.label}</span><small>{item.hint}</small>
				</li>
			{:else}
				<li class="none">No matches</li>
			{/each}
		</ul>
	</Modal>
{/if}
