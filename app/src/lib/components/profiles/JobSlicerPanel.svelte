<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import type { Job } from '$lib/shared/domain';
	import type { ConfigMap, PresetRef } from '$lib/shared/slicer/project';
	import type { JobSliceSettings, JobSliceView } from '$lib/shared/slicer-profiles';
	import { COMMON_KEYS, getJson, refOf, sameRef, shortName } from './api';

	// A queued job's slicer settings: which process and filament preset it slices with and the settings
	// changed for this job only. Without choices the job uses its printer's defaults.
	let { job }: { job: Job } = $props();
	const { lab } = useApp();

	/** The job row carries its settings (jobs.slice_overrides) in the workspace. */
	const saved = $derived(
		(job as Job & { sliceOverrides?: JobSliceSettings | null }).sliceOverrides ?? null
	);
	let open = $state(false);
	let view = $state<JobSliceView | null>(null);
	let error = $state('');
	let busy = $state(false);
	let process = $state('');
	let filament = $state('');
	let rows = $state<{ key: string; value: string }[]>([]);

	const summary = $derived.by(() => {
		if (!saved) return 'Printer defaults';
		const parts = [
			saved.process ? shortName(saved.process.name) : null,
			saved.filaments?.[0] ? shortName(saved.filaments[0].name) : null
		].filter(Boolean);
		const n = Object.keys(saved.overrides?.process ?? {}).length;
		if (n) parts.push(`${n} change${n === 1 ? '' : 's'}`);
		return parts.join(' · ') || 'Printer defaults';
	});

	const key = (r: PresetRef | null | undefined) =>
		r ? (r.source === 'user' ? `user:${r.userPresetId}` : `system:${r.name}`) : '';

	async function load() {
		const r = await getJson<JobSliceView>(`/api/slicer/presets/jobs/${job.id}`);
		view = r.data;
		error = r.error ?? r.data?.error ?? '';
		const s = r.data?.settings ?? {};
		process = key(s.process);
		filament = key(s.filaments?.[0]);
		rows = Object.entries(s.overrides?.process ?? {}).map(([k, v]) => ({
			key: k,
			value: Array.isArray(v) ? v.join(',') : v
		}));
	}

	function toggle() {
		open = !open;
		if (open) void load();
	}

	const find = (list: JobSliceView['processes'], k: string) =>
		list.find((p) => key(refOf(p)) === k);

	async function save() {
		if (!view) return;
		busy = true;
		const p = find(view.processes, process);
		const f = find(view.filaments, filament);
		const overrides: ConfigMap = {};
		for (const r of rows) if (r.key.trim()) overrides[r.key.trim()] = r.value.trim();
		// Printer choices and filament overrides (set through the API) are kept as they are.
		const { printer, overrides: kept } = view.settings;
		const body: JobSliceSettings = {
			...(printer ? { printer } : {}),
			...(p ? { process: refOf(p) } : {}),
			...(f ? { filaments: [refOf(f)] } : {}),
			overrides: { ...kept, process: overrides }
		};
		const r = await lab.call<{ view: JobSliceView }>(
			'PUT',
			`/api/slicer/presets/jobs/${job.id}`,
			body,
			'Slicer settings saved.'
		);
		busy = false;
		if (r) {
			view = r.view;
			open = false;
		}
	}

	const hintFor = (k: string) => COMMON_KEYS.find((c) => c.key === k)?.hint ?? '';
</script>

<div class="slicer-settings">
	<button class="line" aria-expanded={open} onclick={toggle}>
		<span class="label">Slicer settings</span>
		<span class="what">{summary}</span>
		<span class="chev" aria-hidden="true">{open ? '▴' : '▾'}</span>
	</button>
	{#if open}
		<div class="body">
			{#if error}<p class="warn">{error}</p>{/if}
			{#if view && !view.error}
				<label class="field"
					>Process
					<select bind:value={process}>
						<option value=""
							>Default{view.selection && !view.settings.process
								? ` (${view.selection.process.name})`
								: ''}</option
						>
						{#each view.processes as p (p.source + p.id)}
							<option value={key(refOf(p))}
								>{p.name}{p.source === 'user' ? ' · yours' : ''}{sameRef(
									view.selection?.process,
									refOf(p)
								) && !view.settings.process
									? ' ✓'
									: ''}</option
							>
						{/each}
					</select>
				</label>
				<label class="field"
					>Filament
					<select bind:value={filament}>
						<option value=""
							>From the spool or material{view.selection && !view.settings.filaments?.length
								? ` (${view.selection.filaments[0]?.name})`
								: ''}</option
						>
						{#each view.filaments as f (f.source + f.id)}
							<option value={key(refOf(f))}>{f.name}{f.source === 'user' ? ' · yours' : ''}</option>
						{/each}
					</select>
				</label>
				<div class="overrides">
					<span class="sub">Changed for this job only</span>
					{#each rows as row, i (i)}
						<div class="orow">
							<input
								list="slicer-keys-{job.id}"
								aria-label="Setting"
								placeholder="Setting, e.g. wall_loops"
								bind:value={row.key}
							/>
							<input
								aria-label="Value"
								placeholder={hintFor(row.key) || 'Value'}
								bind:value={row.value}
							/>
							<button
								class="mini icon"
								aria-label="Remove {row.key || 'this setting'}"
								onclick={() => (rows = rows.filter((_, j) => j !== i))}>×</button
							>
						</div>
					{/each}
					<button class="mini" onclick={() => (rows = [...rows, { key: '', value: '' }])}
						>＋ Change a setting</button
					>
					<datalist id="slicer-keys-{job.id}">
						{#each COMMON_KEYS as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
					</datalist>
				</div>
				<p class="hint">
					The job’s infill and supports still apply; a setting changed here wins over them.
				</p>
				<div class="acts">
					<button class="mini" onclick={() => (open = false)}>Cancel</button>
					<button class="mini primary-mini" onclick={save} disabled={busy}>Save</button>
				</div>
			{:else if !error}
				<p class="panel-empty">Loading…</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.slicer-settings {
		border-top: 1px solid var(--line);
		margin-top: 8px;
		padding-top: 6px;
	}
	.line {
		display: flex;
		gap: 8px;
		align-items: baseline;
		width: 100%;
		border: 0;
		background: transparent;
		color: var(--text);
		padding: 2px 0;
		text-align: left;
		cursor: pointer;
		font-size: 12.5px;
	}
	.label {
		color: var(--muted);
		white-space: nowrap;
	}
	.what {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chev {
		color: var(--dim);
	}
	.body {
		display: grid;
		gap: 4px;
		padding-top: 8px;
	}
	.body .field {
		margin-bottom: 6px;
	}
	.overrides {
		display: grid;
		gap: 6px;
		justify-items: start;
	}
	.sub {
		font-size: 12.5px;
		color: var(--muted);
	}
	.orow {
		display: grid;
		grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto;
		gap: 6px;
		width: 100%;
	}
	.orow input {
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		padding: 5px 8px;
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		font: 400 13px var(--sans);
		min-width: 0;
	}
	.hint {
		font-size: 12px;
		color: var(--dim);
		margin: 4px 0 0;
	}
	.acts {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}
	.warn {
		color: var(--amber);
		font-size: 13px;
		margin: 0;
	}
</style>
