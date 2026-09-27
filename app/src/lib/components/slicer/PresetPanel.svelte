<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { setFilaments } from '$lib/client/slicer/edit';
	import { slotFromTray, suggestTrays, trayChoices } from '$lib/client/slicer/trays';
	import { getJson, query, refOf, sameRef, shortName } from '$lib/components/profiles/api';
	import { filamentCss } from '$lib/client/slicer-3mf';
	import type { FilamentSlot, PresetRef, PresetSelection } from '$lib/shared/slicer/project';
	import type { PresetSummary } from '$lib/shared/slicer/profiles';
	import { PRINTER_MODELS } from '$lib/shared/printers/models';

	// Printer and filaments: the printer the project is for, its printer, process and filament presets,
	// and which AMS tray each filament comes from (colours follow the tray).
	let { ws }: { ws: WorkspaceState } = $props();
	const { lab, ui } = useApp();

	const project = $derived(ws.project);
	const printer = $derived(lab.printerById(ws.printerId));
	const trays = $derived(trayChoices(printer));
	let printers = $state<PresetSummary[]>([]);
	let processes = $state<PresetSummary[]>([]);
	let filaments = $state<PresetSummary[]>([]);
	let problem = $state('');
	const profiles = $derived(!!ws.backend?.profiles);
	const modelOfPrinter = $derived(printer?.model ?? null);

	// Lists for the printer preset in use (and the printer model, for the printer preset list).
	let asked = 0;
	$effect(() => {
		const name = project.presets.printer.name;
		const model = modelOfPrinter;
		if (!profiles) return;
		const ask = ++asked;
		void (async () => {
			const [p, pr, f] = await Promise.all([
				getJson<PresetSummary[]>(`/api/slicer/profiles?${query({ kind: 'printer', model })}`),
				name
					? getJson<PresetSummary[]>(
							`/api/slicer/profiles?${query({ kind: 'process', printer: name })}`
						)
					: Promise.resolve({ data: [], error: null }),
				name
					? getJson<PresetSummary[]>(
							`/api/slicer/profiles?${query({ kind: 'filament', printer: name })}`
						)
					: Promise.resolve({ data: [], error: null })
			]);
			// A printer whose model has no presets here: offer every printer preset.
			const all = p.data?.length || !model ? (p.data ?? []) : await allPrinters();
			// Answers for a printer chosen before the last one are dropped.
			if (ask !== asked) return;
			printers = all;
			processes = pr.data ?? [];
			filaments = f.data ?? [];
			problem = p.error ?? pr.error ?? f.error ?? '';
		})();
	});

	const allPrinters = async () =>
		(await getJson<PresetSummary[]>(`/api/slicer/profiles?${query({ kind: 'printer' })}`)).data ??
		[];

	const keyOf = (r: PresetRef | null | undefined) =>
		r ? (r.source === 'user' ? `user:${r.userPresetId}` : `${r.source}:${r.name}`) : '';
	const find = (list: PresetSummary[], key: string) => list.find((s) => keyOf(refOf(s)) === key);
	/** A preset from the file that is not in the list is shown as it is. */
	const listed = (list: PresetSummary[], ref: PresetRef) =>
		list.some((s) => sameRef(refOf(s), ref) || s.name === ref.name);

	/** A printer chosen: its model's default presets (slicer-profiles), keeping filaments that still suit. */
	async function choosePrinter(id: string) {
		ws.printerId = id || null;
		const p = lab.printerById(id);
		if (!p?.model || !profiles) return;
		const nozzle = String(p.state?.nozzles[0]?.diameter ?? '0.4');
		const r = await getJson<PresetSelection>(
			`/api/slicer/profiles/defaults?${query({ model: p.model, nozzle })}`
		);
		if (!r.data) return ui.toast(r.error ?? 'No presets for that printer.', 'error');
		const sel = r.data;
		if (sameRef(sel.printer, project.presets.printer)) return;
		ws.change(`Presets for ${p.name ?? PRINTER_MODELS[p.model].short}`, (d) => {
			d.presets = { ...d.presets, printer: sel.printer, process: sel.process };
			const slots: FilamentSlot[] = d.filaments.length
				? d.filaments.map((s) => ({ ...s, preset: sel.filaments[0] ?? s.preset }))
				: sel.filaments.map((preset, i) => ({
						index: i + 1,
						preset,
						color: '#FFFFFF',
						type: 'PLA'
					}));
			setFilaments(d, slots);
		});
		await ws.refreshBed();
	}

	/** The filament to start a slot with: PLA when there is one. */
	const firstFilament = (list: PresetSummary[]) =>
		list.find((f) => f.filamentType === 'PLA' && f.source === 'system') ?? list[0];

	async function setPreset(kind: 'printer' | 'process', key: string, list: PresetSummary[]) {
		const s = find(list, key);
		if (!s) return;
		let start: PresetSummary | undefined;
		// A first printer preset for a project without filaments: one filament slot to go with it.
		if (kind === 'printer' && !project.filaments.length) {
			const r = await getJson<PresetSummary[]>(
				`/api/slicer/profiles?${query({ kind: 'filament', printer: s.name })}`
			);
			start = firstFilament(r.data ?? []);
		}
		ws.change(`Choose ${kind} preset`, (d) => {
			d.presets = { ...d.presets, [kind]: refOf(s) };
			if (start && !d.filaments.length)
				setFilaments(d, [
					{ index: 1, preset: refOf(start), color: '#FFFFFF', type: start.filamentType ?? 'PLA' }
				]);
		});
		if (kind === 'printer') void ws.refreshBed();
	}

	function setSlot(i: number, patch: Partial<FilamentSlot>, label = 'Change filament') {
		ws.change(label, (d) =>
			setFilaments(
				d,
				d.filaments.map((s, k) => (k === i ? { ...s, ...patch } : s))
			)
		);
	}

	function setSlotPreset(i: number, key: string) {
		const s = find(filaments, key);
		if (s) setSlot(i, { preset: refOf(s), type: s.filamentType ?? project.filaments[i].type });
	}

	/** A tray chosen: its colour and material, and the preset for what it holds when one matches. */
	async function setSlotTray(i: number, value: string) {
		const tray = trays.find((t) => String(t.index) === value) ?? null;
		const slot = slotFromTray(project.filaments[i], tray);
		if (tray && ws.printerId && profiles) {
			const r = await getJson<{ preset: PresetSummary | null }>(
				`/api/slicer/profiles/tray?${query({ printer: ws.printerId, tray: String(tray.index) })}`
			);
			if (r.data?.preset) slot.preset = refOf(r.data.preset);
		}
		setSlot(i, slot, tray ? `Use ${tray.label}` : 'No tray');
	}

	function addSlot() {
		const last = project.filaments.at(-1);
		const start = firstFilament(filaments);
		const preset: PresetRef =
			last?.preset ?? (start ? refOf(start) : { kind: 'filament', name: '', source: 'system' });
		const type = last?.type ?? start?.filamentType ?? 'PLA';
		ws.change('Add filament', (d) =>
			setFilaments(d, [...d.filaments, { index: 0, preset, color: '#FFFFFF', type }])
		);
	}

	function removeSlot(i: number) {
		ws.change('Remove filament', (d) =>
			setFilaments(
				d,
				d.filaments.filter((_, k) => k !== i)
			)
		);
	}

	function matchTrays() {
		const picks = suggestTrays(project.filaments, trays);
		ws.change('Match the AMS', (d) =>
			setFilaments(
				d,
				d.filaments.map((s, i) => slotFromTray(s, trays.find((t) => t.index === picks[i]) ?? null))
			)
		);
	}
</script>

<section class="panel sp" aria-label="Printer and filaments">
	<h2 class="panel-title">Printer and filaments</h2>
	<label class="field"
		>Printer
		<select value={ws.printerId ?? ''} onchange={(e) => choosePrinter(e.currentTarget.value)}>
			<option value="">Choose when sending</option>
			{#each lab.printerList as p (p.id)}
				<option value={p.id}>{p.name} · {p.model ? PRINTER_MODELS[p.model].short : ''}</option>
			{/each}
		</select>
	</label>
	{#if !profiles}
		<p class="hint">
			Preset lists need slicer profiles (see Integrations). The presets named in the file are used.
		</p>
		<dl class="names">
			<dt>Printer</dt>
			<dd>{project.presets.printer.name || '—'}</dd>
			<dt>Process</dt>
			<dd>{project.presets.process.name || '—'}</dd>
		</dl>
	{:else}
		{#if problem}<p class="hint warn">{problem}</p>{/if}
		<label class="field"
			>Printer preset
			<select
				value={keyOf(project.presets.printer)}
				onchange={(e) => setPreset('printer', e.currentTarget.value, printers)}
			>
				{#if !project.presets.printer.name}<option value={keyOf(project.presets.printer)}
						>Choose…</option
					>{/if}
				{#if project.presets.printer.name && !listed(printers, project.presets.printer)}
					<option value={keyOf(project.presets.printer)}
						>{project.presets.printer.name} (from the file)</option
					>
				{/if}
				{#each printers as p (p.source + p.id)}
					<option value={keyOf(refOf(p))}>{p.name}{p.source === 'user' ? ' · yours' : ''}</option>
				{/each}
			</select>
		</label>
		<label class="field"
			>Process
			<select
				value={keyOf(project.presets.process)}
				onchange={(e) => setPreset('process', e.currentTarget.value, processes)}
				disabled={!project.presets.printer.name}
			>
				{#if !project.presets.process.name}<option value={keyOf(project.presets.process)}
						>Choose…</option
					>{/if}
				{#if project.presets.process.name && !listed(processes, project.presets.process)}
					<option value={keyOf(project.presets.process)}
						>{project.presets.process.name} (from the file)</option
					>
				{/if}
				{#each processes as p (p.source + p.id)}
					<option value={keyOf(refOf(p))}
						>{shortName(p.name)}{p.source === 'user' ? ' · yours' : ''}</option
					>
				{/each}
			</select>
		</label>
	{/if}

	<div class="slots">
		<div class="slots-head">
			<span class="sub">Filaments</span>
			{#if trays.length}<button
					class="mini"
					onclick={matchTrays}
					title="Pick the loaded tray closest to each filament">Match the AMS</button
				>{/if}
		</div>
		{#each project.filaments as slot, i (i)}
			<div class="slot">
				<span class="num" style:--c={filamentCss(slot.color) ?? '#888'}>{slot.index}</span>
				<input
					type="color"
					aria-label="Colour of filament {slot.index}"
					value={filamentCss(slot.color) ?? '#ffffff'}
					onchange={(e) =>
						setSlot(i, { color: e.currentTarget.value.toUpperCase() }, 'Change colour')}
				/>
				{#if profiles}
					<select
						aria-label="Preset of filament {slot.index}"
						value={keyOf(slot.preset)}
						onchange={(e) => setSlotPreset(i, e.currentTarget.value)}
					>
						{#if !listed(filaments, slot.preset)}
							<option value={keyOf(slot.preset)}>{shortName(slot.preset.name) || 'Choose…'}</option>
						{/if}
						{#each filaments as f (f.source + f.id)}
							<option value={keyOf(refOf(f))}
								>{shortName(f.name)}{f.source === 'user' ? ' · yours' : ''}</option
							>
						{/each}
					</select>
				{:else}
					<span class="fname">{shortName(slot.preset.name) || slot.type}</span>
				{/if}
				{#if project.filaments.length > 1}
					<button
						class="icon-button"
						aria-label="Remove filament {slot.index}"
						onclick={() => removeSlot(i)}>×</button
					>
				{/if}
				{#if trays.length}
					<select
						class="tray"
						aria-label="Tray of filament {slot.index}"
						value={slot.tray === null || slot.tray === undefined ? '' : String(slot.tray)}
						onchange={(e) => setSlotTray(i, e.currentTarget.value)}
					>
						<option value="">No tray chosen</option>
						{#each trays as t (t.index)}
							<option value={String(t.index)}
								>{t.label} · {t.type}{t.name ? ` · ${t.name}` : ''}</option
							>
						{/each}
					</select>
				{/if}
			</div>
		{/each}
		{#if project.filaments.length < 16}
			<button class="mini" onclick={addSlot}>+ Filament</button>
		{/if}
	</div>
</section>

<style>
	.sp {
		display: grid;
		gap: 10px;
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.warn {
		color: var(--err-text);
	}
	.names {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 10px;
		margin: 0;
		font-size: 12.5px;
	}
	.names dt {
		color: var(--muted);
	}
	.names dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.slots {
		display: grid;
		gap: 6px;
	}
	.slots-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.sub {
		font-size: 12px;
		color: var(--muted);
	}
	.slot {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		align-items: center;
		min-width: 0;
	}
	.slot select {
		flex: 1;
		min-width: 0;
	}
	.slot .tray {
		flex: 1 0 100%;
		margin-left: 28px;
		max-width: calc(100% - 28px);
		font-size: 12px;
	}
	.num {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 6px;
		background: var(--c);
		color: #111;
		font-size: 11px;
		font-weight: 700;
		flex: none;
		box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.25);
	}
	input[type='color'] {
		width: 26px;
		height: 24px;
		padding: 0;
		border: 0;
		background: none;
		flex: none;
	}
	.fname {
		flex: 1;
		font-size: 12.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
