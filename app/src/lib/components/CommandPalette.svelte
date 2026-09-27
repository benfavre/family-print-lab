<script lang="ts">
	import { modelHref } from '$lib/client/models';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { THEMES, useApp } from '$lib/client/app.svelte';
	import { actions, projectHref } from '$lib/client/actions';
	import { weight } from '$lib/client/format';
	import Modal from './Modal.svelte';
	import { UI } from '$lib/client/registry';
	import { INTEGRATIONS_NAV, NAV } from '$lib/client/nav';
	import { searchPalette, type PaletteItem } from '$lib/client/palette';

	const app = useApp();
	const { lab, ui } = app;
	let q = $state('');
	let index = $state(0);

	interface Item extends PaletteItem {
		run: () => unknown;
	}
	// Longer names and search words for some sections, by their G shortcut key.
	const SECTION_NAMES: Record<string, { label?: string; keywords?: string }> = {
		r: { label: 'Printers (live)' },
		f: { label: 'Filament shelf', keywords: 'spools' },
		i: { label: 'Integrations (Claude, ChatGPT, Blender, printer)' }
	};
	const source = $derived.by((): Item[] => {
		const act = actions(app);
		const current = page.params.id ? lab.project(page.params.id) : undefined;
		return [
			// Every section, including the ones packages register (NAV hrefs are built with resolve()).
			...[...NAV, INTEGRATIONS_NAV].map((n) => ({
				label: SECTION_NAMES[n.key]?.label ?? n.label,
				hint: 'Go to',
				keywords: SECTION_NAMES[n.key]?.keywords,
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- see above
				run: () => goto(n.href)
			})),
			...lab.printerList.map((p) => ({
				label: `${p.name} (printer)`,
				hint: 'Go to',
				run: () => goto(resolve('/printers/[id]', { id: p.id ?? '' }))
			})),
			...UI.paletteCommands.map((c) => ({
				label: c.label,
				hint: c.hint ?? 'Action',
				keywords: c.keywords,
				run: () => c.run(app)
			})),
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
	const items = $derived(searchPalette(source, q));

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
