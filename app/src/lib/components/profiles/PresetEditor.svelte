<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import type { ConfigMap, ConfigValue, PresetRef } from '$lib/shared/slicer/project';
	import type { PresetDetail, PresetKey } from '$lib/shared/slicer-profiles';
	import { detailUrl, getJson, showValue } from './api';
	import ValueInput from './ValueInput.svelte';

	// One preset, its keys grouped like Bambu Studio's tabs. A system preset is read-only and can be
	// saved as your own; your own presets are edited in place and keep only what differs from the
	// Bambu Studio preset they are based on.
	let { preset, onclose }: { preset: PresetRef; onclose: () => void } = $props();
	const { lab, ui } = useApp();
	// The parent recreates the editor for another preset ({#key}); "Save as" switches to the copy here.
	let ref = $state(untrack(() => preset));

	let detail = $state<PresetDetail | null>(null);
	let error = $state('');
	let edits = $state<ConfigMap>({});
	let removed = $state<string[]>([]);
	let name = $state('');
	let saveAs = $state('');
	let page = $state('');
	let onlyChanged = $state(false);
	let search = $state('');
	let newKey = $state('');
	let newValue = $state('');
	let busy = $state(false);

	async function load(ref: PresetRef) {
		const r = await getJson<PresetDetail>(detailUrl(ref));
		detail = r.data;
		error = r.error ?? '';
		edits = {};
		removed = [];
		name = r.data?.user?.name ?? '';
		saveAs = r.data ? `${r.data.preset.name.replace(/\s*@.*$/, '')} (mine)` : '';
		if (r.data && !r.data.pages.some((p) => p.page === page)) page = r.data.pages[0]?.page ?? '';
	}
	$effect(() => {
		void load(ref);
	});

	const user = $derived(detail?.user ?? null);
	const isChanged = (k: PresetKey) => k.key in edits || (k.changed && !removed.includes(k.key));
	const current = (k: PresetKey): ConfigValue =>
		k.key in edits ? edits[k.key] : removed.includes(k.key) ? (k.parent ?? k.value) : k.value;
	const matches = (k: PresetKey) =>
		(!onlyChanged || isChanged(k)) && (!search || k.key.includes(search.trim().toLowerCase()));
	const visible = $derived(
		(detail?.pages ?? [])
			.map((p) => ({
				...p,
				groups: p.groups
					.map((g) => ({ ...g, keys: g.keys.filter(matches) }))
					.filter((g) => g.keys.length)
			}))
			.filter((p) => p.groups.length)
	);
	const shown = $derived(
		visible.find((p) => p.page === page) ?? (search || onlyChanged ? visible[0] : undefined)
	);
	const changedCount = $derived(
		(detail?.pages ?? []).reduce(
			(n, p) => n + p.groups.reduce((m, g) => m + g.keys.filter(isChanged).length, 0),
			0
		)
	);
	const dirty = $derived(
		Object.keys(edits).length > 0 || removed.length > 0 || (!!user && name !== user.name)
	);

	function edit(key: string, v: ConfigValue) {
		edits = { ...edits, [key]: v };
		removed = removed.filter((k) => k !== key);
	}
	function reset(k: PresetKey) {
		const rest = { ...edits };
		delete rest[k.key];
		edits = rest;
		if (user && k.key in user.config && !removed.includes(k.key)) removed = [...removed, k.key];
	}
	function addKey() {
		const key = newKey.trim();
		if (!/^[a-z][a-z0-9_]{0,99}$/.test(key))
			return ui.toast('Setting names are lower case with underscores, e.g. wall_loops.', 'error');
		edit(key, newValue);
		newKey = '';
		newValue = '';
		onlyChanged = true;
	}

	/** What a user preset stores after this edit: its keys, minus the reset ones, plus the edits. */
	function storedConfig(): ConfigMap {
		const out: ConfigMap = { ...(user?.config ?? {}) };
		for (const k of removed) delete out[k];
		return { ...out, ...edits };
	}

	async function save() {
		if (!user) return;
		busy = true;
		const r = await lab.call<{ preset: { version: number } }>(
			'PATCH',
			`/api/slicer/presets/${user.id}`,
			{
				version: (user as { version?: number }).version ?? 1,
				name: name.trim(),
				config: storedConfig()
			},
			'Preset saved.'
		);
		busy = false;
		if (r) await load(ref.source === 'user' ? { ...ref, name: name.trim() } : ref);
	}

	async function saveAsNew() {
		if (!detail || !saveAs.trim()) return;
		busy = true;
		const r = await lab.call<{ preset: { id: string; name: string } }>(
			'POST',
			'/api/slicer/presets',
			{ kind: detail.preset.kind, name: saveAs.trim(), from: ref, config: edits },
			'Saved as your own preset.'
		);
		busy = false;
		if (r)
			ref = {
				kind: detail.preset.kind,
				name: r.preset.name,
				source: 'user',
				userPresetId: r.preset.id
			};
	}

	async function remove() {
		if (!user) return;
		if (await ui.ask(`Delete “${user.name}”?`, 'Jobs that use it go back to the default preset.'))
			if (await lab.call('DELETE', `/api/slicer/presets/${user.id}`, undefined, 'Preset deleted.'))
				onclose();
	}
</script>

<div class="editor" aria-label="Preset editor">
	<div class="editor-head">
		<div class="title">
			<span class="eyebrow"
				>{ref.kind === 'process' ? 'PROCESS' : ref.kind === 'filament' ? 'FILAMENT' : 'PRINTER'}
				· {user ? 'YOURS' : 'BAMBU STUDIO'}</span
			>
			{#if user}
				<input class="name" aria-label="Preset name" bind:value={name} maxlength="120" />
			{:else}
				<h3>{detail?.preset.name ?? ref.name}</h3>
			{/if}
			{#if detail}
				<small
					>{detail.preset.chain.slice(1).join(' ← ') || 'No parent'}{changedCount
						? ` · ${changedCount} changed from ${user ? (user.inherits ?? 'nothing') : 'its parent'}`
						: ''}</small
				>
			{/if}
		</div>
		<button class="icon-button" aria-label="Close the preset" onclick={onclose}>×</button>
	</div>

	{#if error}
		<p class="warn">{error}</p>
	{:else if !detail}
		<p class="panel-empty">Loading…</p>
	{:else}
		<div class="tools">
			<input
				class="search"
				type="search"
				placeholder="Find a setting"
				aria-label="Find a setting"
				bind:value={search}
			/>
			<label class="toggle"><input type="checkbox" bind:checked={onlyChanged} /> Only changes</label
			>
		</div>
		<div class="tabs" role="tablist" aria-label="Setting pages">
			{#each visible as p (p.page)}
				<button
					role="tab"
					class="tab"
					aria-selected={shown?.page === p.page}
					class:on={shown?.page === p.page}
					onclick={() => (page = p.page)}>{p.page}</button
				>
			{/each}
		</div>
		{#if shown}
			{#each shown.groups as g (g.group)}
				<fieldset>
					<legend>{g.group}</legend>
					{#each g.keys as k (k.key)}
						<div class="row" class:changed={isChanged(k)}>
							<code class="key" title={`Set by ${k.origin}`}>{k.key}</code>
							<ValueInput value={current(k)} label={k.key} onchange={(v) => edit(k.key, v)} />
							<span class="was">
								{#if isChanged(k) && (k.parent !== null || k.key in edits)}
									<small title="The parent’s value"
										>was {showValue(k.key in edits ? k.value : k.parent)}</small
									>
								{/if}
								{#if k.key in edits || (user && k.changed && !removed.includes(k.key))}
									<button
										class="mini icon"
										aria-label="Undo the change to {k.key}"
										title="Undo"
										onclick={() => reset(k)}>↺</button
									>
								{/if}
							</span>
						</div>
					{/each}
				</fieldset>
			{/each}
		{:else}
			<p class="panel-empty">{onlyChanged ? 'Nothing changed yet.' : 'No setting matches.'}</p>
		{/if}

		<details class="add">
			<summary>Add a setting by name</summary>
			<div class="add-row">
				<input aria-label="Setting name" placeholder="e.g. brim_width" bind:value={newKey} />
				<input aria-label="Value" placeholder="Value" bind:value={newValue} />
				<button class="mini" onclick={addKey} disabled={!newKey.trim()}>Add</button>
			</div>
		</details>

		<div class="actions">
			{#if user}
				<button class="mini danger-mini" onclick={remove} disabled={busy}>Delete</button>
				<a class="mini" href={resolve('/api/slicer/presets/[id]/export', { id: user.id })} download
					>Export .json</a
				>
				{#if user.kind !== 'process'}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() plus a query -->
					<a
						class="mini"
						href="{resolve('/api/slicer/presets/[id]/export', { id: user.id })}?bundle=1"
						download>Export {user.kind === 'printer' ? '.bbscfg' : '.bbsflmt'}</a
					>
				{/if}
				<span class="grow"></span>
				<button class="mini primary-mini" onclick={save} disabled={busy || !dirty || !name.trim()}
					>Save changes</button
				>
			{:else}
				<span class="grow"></span>
				<input
					class="save-name"
					aria-label="Name for your copy"
					bind:value={saveAs}
					maxlength="120"
				/>
				<button class="mini primary-mini" onclick={saveAsNew} disabled={busy || !saveAs.trim()}
					>Save as my preset</button
				>
			{/if}
		</div>
	{/if}
</div>

<style>
	.editor {
		border: 1px solid var(--line-strong);
		border-radius: var(--r-md);
		background: var(--panel);
		padding: 12px;
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.editor-head {
		display: flex;
		justify-content: space-between;
		gap: 10px;
	}
	.title {
		display: grid;
		gap: 3px;
		min-width: 0;
	}
	.title h3 {
		margin: 0;
		font-size: 15px;
		overflow-wrap: anywhere;
	}
	.title small {
		color: var(--dim);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.eyebrow {
		font-size: 11px;
		letter-spacing: 0.08em;
		color: var(--dim);
	}
	.name,
	.save-name,
	.search,
	.add-row input {
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		padding: 5px 9px;
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		font: 400 13px var(--sans);
		min-width: 0;
	}
	.name {
		font-size: 15px;
		font-weight: 600;
	}
	.tools {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}
	.search {
		flex: 1 1 200px;
	}
	.toggle {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		font-size: 13px;
		color: var(--muted);
	}
	.tabs {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		border-bottom: 1px solid var(--line);
		padding-bottom: 6px;
	}
	.tab {
		border: 0;
		background: transparent;
		color: var(--muted);
		padding: 4px 10px;
		border-radius: var(--r-sm);
		font-size: 13px;
		cursor: pointer;
	}
	.tab.on {
		color: var(--text);
		background: rgb(var(--hi) / 0.07);
	}
	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 4px;
	}
	legend {
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
		margin-bottom: 4px;
	}
	.row {
		display: grid;
		grid-template-columns: minmax(140px, 240px) minmax(0, 1fr) minmax(0, auto);
		gap: 8px;
		align-items: center;
		padding: 2px 4px;
		border-radius: var(--r-sm);
	}
	.row.changed {
		background: rgb(var(--c4) / 0.08);
	}
	.key {
		font-size: 12px;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.was {
		display: inline-flex;
		gap: 4px;
		align-items: center;
		justify-content: flex-end;
	}
	.was small {
		color: var(--dim);
		font-size: 11.5px;
		max-width: 22ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.add summary {
		font-size: 13px;
		color: var(--muted);
		cursor: pointer;
	}
	.add-row {
		display: flex;
		gap: 6px;
		margin-top: 6px;
		flex-wrap: wrap;
	}
	.add-row input {
		flex: 1 1 140px;
	}
	.actions {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
	}
	.actions a.mini {
		text-decoration: none;
	}
	.grow {
		flex: 1;
	}
	.warn {
		color: var(--amber);
		font-size: 13px;
	}
	@media (max-width: 700px) {
		.row {
			grid-template-columns: minmax(0, 1fr);
		}
		.was {
			justify-content: flex-start;
		}
	}
</style>
