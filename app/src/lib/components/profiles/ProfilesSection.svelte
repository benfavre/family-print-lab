<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import type { ModelCode } from '$lib/shared/printers/models';
	import type { PresetRef } from '$lib/shared/slicer/project';
	import type { PresetKind, PresetSummary } from '$lib/shared/slicer/profiles';
	import type { ProfilesOverview } from '$lib/shared/slicer-profiles';
	import { getJson, query, refOf, shortName } from './api';
	import PresetEditor from './PresetEditor.svelte';

	// Settings → Slicer profiles: Bambu Studio's presets for each printer model, your own presets,
	// editing, and moving presets to and from Bambu Studio.
	const { lab, ui } = useApp();
	let overview = $state<ProfilesOverview | null>(null);
	let loadError = $state('');
	let model = $state<ModelCode | ''>('');
	let nozzle = $state('0.4');
	let kind = $state<PresetKind>('process');
	let presets = $state<PresetSummary[]>([]);
	let listError = $state('');
	let filter = $state('');
	let open = $state<PresetRef | null>(null);
	let openKey = $state(0);
	let fileInput = $state<HTMLInputElement>();
	let importing = $state(false);

	const KINDS: { id: PresetKind; label: string }[] = [
		{ id: 'process', label: 'Process' },
		{ id: 'filament', label: 'Filament' },
		{ id: 'printer', label: 'Printer' }
	];
	const models = $derived((overview?.models ?? []).filter((m) => m.nozzles.length));
	const current = $derived(models.find((m) => m.code === model));
	const shown = $derived(
		presets.filter(
			(p) => !filter.trim() || p.name.toLowerCase().includes(filter.trim().toLowerCase())
		)
	);

	async function loadOverview() {
		const r = await getJson<ProfilesOverview>('/api/slicer/profiles');
		overview = r.data;
		loadError = r.error ?? '';
		if (r.data && !model) {
			// Start with the first saved printer's model, else the first model the presets cover.
			const first = lab.primaryPrinter?.model;
			const covered = r.data.models.filter((m) => m.nozzles.length);
			model = covered.find((m) => m.code === first)?.code ?? covered[0]?.code ?? '';
		}
	}

	// Only the latest request fills the list (switching printer or kind quickly).
	let listSeq = 0;
	async function loadList() {
		const seq = ++listSeq;
		if (!model) return (presets = []);
		const r = await getJson<PresetSummary[]>(
			`/api/slicer/profiles?${query({ kind, model, nozzle })}`
		);
		if (seq !== listSeq) return;
		presets = r.data ?? [];
		listError = r.error ?? '';
	}

	onMount(() => {
		void loadOverview();
		return lab.onLive('slicer-profiles:presets', () => {
			void loadOverview();
			void loadList();
		});
	});
	$effect(() => {
		if (current && !current.nozzles.includes(nozzle))
			nozzle = current.nozzles.includes('0.4') ? '0.4' : current.nozzles[0];
	});
	$effect(() => {
		void [model, nozzle, kind];
		void loadList();
	});

	function show(ref: PresetRef) {
		open = ref;
		openKey++;
	}

	async function importFile(file: File) {
		if (file.size > 5_000_000) return ui.toast('Preset files must be under 5 MB.', 'error');
		importing = true;
		try {
			const r = await fetch(`/api/slicer/presets/import?${query({ name: file.name })}`, {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: file
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) return ui.toast(data.error ?? 'Import failed.', 'error');
			const n = data.imported.length;
			const skipped = data.skipped as { name: string; reason: string }[];
			ui.toast(
				n
					? `Imported ${n} preset${n === 1 ? '' : 's'}${skipped.length ? `; skipped ${skipped.length}` : ''}.`
					: `Nothing imported: ${skipped.map((s) => `${s.name}: ${s.reason}`).join(' ')}`,
				n ? 'ok' : 'error'
			);
			await loadOverview();
			await loadList();
		} catch {
			ui.toast('Could not reach the app server.', 'error');
		} finally {
			importing = false;
			if (fileInput) fileInput.value = '';
		}
	}
</script>

<section class="profiles" id="slicer-profiles" aria-label="Slicer profiles">
	<div class="section-head">
		<h2>Slicer profiles</h2>
		<div class="head-actions">
			<button class="secondary" disabled={importing} onclick={() => fileInput?.click()}
				>{importing ? 'Importing…' : 'Import from Bambu Studio'}</button
			>
			<input
				bind:this={fileInput}
				type="file"
				accept=".json,.bbscfg,.bbsflmt,.zip"
				hidden
				onchange={(e) => {
					const f = e.currentTarget.files?.[0];
					if (f) void importFile(f);
				}}
			/>
		</div>
	</div>
	<p class="lead">
		The printer, process and filament presets the app slices with: Bambu Studio’s own{overview?.vendor
			? ` (${overview.vendor.tag}, set ${overview.vendor.version})`
			: ''}, plus yours. Yours keep only what you change, like in Bambu Studio, and export as files
		Bambu Studio imports.
	</p>

	{#if loadError}
		<p class="warn">{loadError}</p>
	{:else if !overview}
		<p class="panel-empty">Loading…</p>
	{:else if overview.missing}
		<p class="warn">{overview.missing}</p>
		<pre class="cmd">bun run profiles:fetch</pre>
	{/if}

	{#if overview && !overview.missing}
		<div class="browse">
			<label class="field"
				>Printer
				<select bind:value={model} aria-label="Printer model">
					{#each models as m (m.code)}<option value={m.code}>{m.short}</option>{/each}
				</select>
			</label>
			<label class="field"
				>Nozzle
				<select bind:value={nozzle} aria-label="Nozzle">
					{#each current?.nozzles ?? [] as n (n)}<option value={n}>{n} mm</option>{/each}
				</select>
			</label>
			<div class="kinds" role="tablist" aria-label="Preset kind">
				{#each KINDS as k (k.id)}
					<button
						role="tab"
						aria-selected={kind === k.id}
						class="mini"
						class:primary-mini={kind === k.id}
						onclick={() => (kind = k.id)}>{k.label}</button
					>
				{/each}
			</div>
			<input
				class="filter"
				type="search"
				placeholder="Filter"
				aria-label="Filter presets"
				bind:value={filter}
			/>
		</div>
		{#if listError}<p class="warn">{listError}</p>{/if}
		<ul class="preset-list" aria-label="{kind} presets">
			{#each shown as p (p.source + p.id)}
				<li>
					<button class="pick" onclick={() => show(refOf(p))}>
						<span class="pname">{p.name}</span>
						<small
							>{p.source === 'user'
								? `Yours · based on ${p.inherits ?? 'nothing'}`
								: 'Bambu Studio'}{p.filamentType ? ` · ${p.filamentType}` : ''}{p.filamentId
								? ` · ${p.filamentId}`
								: ''}</small
						>
					</button>
				</li>
			{:else}
				<li class="panel-empty">No presets for this printer and nozzle.</li>
			{/each}
		</ul>
	{/if}

	{#if overview?.users.length}
		<h3>Your presets</h3>
		<ul class="preset-list mine" aria-label="Your presets">
			{#each overview.users as u (u.id)}
				<li>
					<button
						class="pick"
						onclick={() => show({ kind: u.kind, name: u.name, source: 'user', userPresetId: u.id })}
					>
						<span class="pname">{u.name}</span>
						<small
							>{u.kind} · based on {u.inherits ? shortName(u.inherits) : 'nothing'} · {Object.keys(
								u.config
							).length} change{Object.keys(u.config).length === 1 ? '' : 's'}</small
						>
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if open}
		{#key openKey}
			<PresetEditor preset={open} onclose={() => (open = null)} />
		{/key}
	{/if}
</section>

<style>
	.profiles {
		margin-bottom: 26px;
		display: grid;
		gap: 10px;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	h2 {
		font-size: 15px;
		margin: 0;
	}
	h3 {
		font-size: 13px;
		margin: 6px 0 0;
		color: var(--muted);
	}
	.lead {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
		max-width: 90ch;
	}
	.cmd {
		margin: 0;
		font: 12.5px var(--mono);
		padding: 6px 10px;
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.05);
		width: fit-content;
	}
	.browse {
		display: flex;
		gap: 10px;
		align-items: flex-end;
		flex-wrap: wrap;
	}
	.browse .field {
		margin: 0;
		min-width: 120px;
	}
	.kinds {
		display: flex;
		gap: 4px;
		padding-bottom: 6px;
	}
	.filter {
		flex: 1 1 160px;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-md);
		padding: 7px 10px;
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		font: 400 13px var(--sans);
		margin-bottom: 2px;
	}
	.preset-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 6px;
		max-height: 340px;
		overflow: auto;
	}
	.preset-list.mine {
		max-height: none;
	}
	.pick {
		width: 100%;
		text-align: left;
		display: grid;
		gap: 2px;
		padding: 8px 10px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: var(--panel);
		color: var(--text);
		cursor: pointer;
	}
	.pick:hover {
		border-color: var(--line-strong);
	}
	.pname {
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.pick small {
		color: var(--dim);
		font-size: 12px;
	}
	.warn {
		color: var(--amber);
		font-size: 13px;
		margin: 0;
	}
</style>
