<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { download, projectHref } from '$lib/client/actions';
	import { getSlicerProject, SLICER_ACCEPT, slicerFileUrl } from '$lib/client/slicer-3mf';
	import { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { previewUrl } from '$lib/client/slicer/api';
	import { addPlate } from '$lib/client/slicer/edit';
	import GcodePreview from '$lib/components/gcode/GcodePreview.svelte';
	import SlicerStage from '$lib/components/slicer/SlicerStage.svelte';
	import PresetPanel from '$lib/components/slicer/PresetPanel.svelte';
	import ObjectList from '$lib/components/slicer/ObjectList.svelte';
	import ObjectPanel from '$lib/components/slicer/ObjectPanel.svelte';
	import PaintPanel from '$lib/components/slicer/PaintPanel.svelte';
	import PlatePanel from '$lib/components/slicer/PlatePanel.svelte';
	import SlicePanel from '$lib/components/slicer/SlicePanel.svelte';
	import type { SlicerScene } from '$lib/components/slicer/scene';

	// The slicer workspace: plates, objects and their settings, painting, slicing with progress, the
	// toolpath preview and sending, on one slicer project (a Bambu Studio project file).
	const { lab, ui } = useApp();
	const slicerId = $derived(page.params.slicerProjectId!);
	let ws = $state<WorkspaceState | null>(null);
	let name = $state('');
	let problem = $state('');
	let scene = $state<SlicerScene | null>(null);
	let fileInput = $state<HTMLInputElement>();
	let addOpen = $state(false);

	const owner = $derived(lab.project(page.params.id));
	const models = $derived(
		lab.ws.models
			.filter((m) => m.projectId === page.params.id && m.currentVersionId)
			.sort((a, b) => a.name.localeCompare(b.name))
	);

	async function load(id: string) {
		ws?.dispose();
		ws = null;
		try {
			const detail = await getSlicerProject(id);
			name = detail.name;
			const next = new WorkspaceState(id, detail.projectId, detail, lab, ui);
			ws = next;
			await next.start();
			await next.refreshDefaults();
			// The printer the presets are for, else the first one.
			const match = lab.printerList.find((p) => p.modelName === next.bed.printerModel);
			next.printerId = (match ?? lab.primaryPrinter)?.id ?? null;
			problem = '';
		} catch (e) {
			problem = (e as Error).message;
		}
	}
	$effect(() => {
		const id = slicerId;
		untrack(() => void load(id));
	});
	onDestroy(() => ws?.dispose());
	// Leaving the page saves what is not saved yet; closing the tab asks first.
	beforeNavigate(() => void ws?.doc.save());
	function beforeUnload(e: BeforeUnloadEvent) {
		if (ws?.doc.dirty) e.preventDefault();
	}

	// New presets (chosen, or brought back by undo): new placeholders and the printer preset's bed.
	let presetKey = '';
	let printerKey = '';
	$effect(() => {
		if (!ws) return;
		const key = JSON.stringify(ws.project.presets);
		if (key === presetKey) return;
		const first = !presetKey;
		const printer = JSON.stringify(ws.project.presets.printer);
		const printerChanged = printer !== printerKey;
		presetKey = key;
		printerKey = printer;
		if (first) return;
		void ws.refreshDefaults();
		if (printerChanged) void ws.refreshBed();
	});

	function choosePlate(index: number) {
		if (!ws) return;
		ws.plate = index;
		ws.selection = { items: [], partId: null };
		scene?.focusPlate(index);
	}

	function newPlate() {
		if (!ws) return;
		let index = 0;
		ws.change('Add plate', (d) => (index = addPlate(d, ws!.bed).index));
		if (index) choosePlate(index);
	}

	async function openInBambu() {
		if (!ws) return;
		if (!(await ws.doc.save()))
			return ui.toast(ws.doc.problem || 'Save the project first.', 'error');
		download(slicerFileUrl(ws.id));
	}

	function keydown(e: KeyboardEvent) {
		if (!ws) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		const mod = e.ctrlKey || e.metaKey;
		const key = e.key.toLowerCase();
		if (mod && key === 'z' && !e.shiftKey) ws.doc.undo();
		else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) ws.doc.redo();
		else if (mod && key === 'a') ws.selectAll();
		else if (mod && key === 'd') ws.duplicateSelection();
		else if (!mod && (key === 'delete' || key === 'backspace')) ws.deleteSelection();
		else if (!mod && key === 'escape') {
			ws.paint = null;
			ws.layFace = false;
			ws.selection = { items: [], partId: null };
		} else if (!mod && key === 'm') ws.gizmo = 'translate';
		else if (!mod && key === 'r') ws.gizmo = 'rotate';
		else if (!mod && key === 's') ws.gizmo = 'scale';
		else if (!mod && key === 'f') ws.layFace = !ws.layFace;
		else return;
		e.preventDefault();
	}

	const saveState = $derived(
		!ws
			? ''
			: ws.doc.problem
				? ws.doc.problem
				: ws.doc.saving
					? 'Saving…'
					: ws.doc.dirty
						? 'Unsaved changes'
						: 'Saved'
	);
	const result = $derived(ws?.plateResult() ?? null);
</script>

<svelte:head><title>{name || 'Slicer'} · Family Print Lab</title></svelte:head>
<svelte:window onkeydown={keydown} onbeforeunload={beforeUnload} />

<div class="sw">
	<header class="sw-top">
		<div class="crumbs">
			{#if owner}<a href={projectHref(owner.id)}>{owner.title}</a><span aria-hidden="true">›</span
				>{/if}
			<h1>{name || 'Slicer'}</h1>
			{#if ws}<span class="save" class:bad={!!ws.doc.problem} role="status">{saveState}</span>{/if}
			{#if ws?.doc.problem}<button
					class="mini"
					onclick={() => load(slicerId)}
					title="Drop the changes here and open the saved project">Reload</button
				>{/if}
		</div>
		{#if ws}
			<div class="top-actions">
				<button
					class="mini"
					disabled={!ws.doc.undoLabel}
					title={ws.doc.undoLabel ? `Undo ${ws.doc.undoLabel.toLowerCase()} (Ctrl+Z)` : 'Undo'}
					onclick={() => ws?.doc.undo()}>Undo</button
				>
				<button
					class="mini"
					disabled={!ws.doc.redoLabel}
					title={ws.doc.redoLabel ? `Redo ${ws.doc.redoLabel.toLowerCase()} (Ctrl+Y)` : 'Redo'}
					onclick={() => ws?.doc.redo()}>Redo</button
				>
				<button
					class="secondary"
					onclick={openInBambu}
					title="Download the project file for Bambu Studio or OrcaSlicer"
					>Open in Bambu Studio</button
				>
			</div>
		{/if}
	</header>

	{#if problem}
		<section class="panel"><p class="panel-empty" role="alert">{problem}</p></section>
	{:else if !ws}
		<p class="panel-empty">Opening the project…</p>
	{:else}
		<div class="toolbar-row" role="toolbar" aria-label="Workspace tools">
			<div class="seg" role="tablist" aria-label="View">
				<button
					role="tab"
					aria-selected={ws.tab === 'prepare'}
					class:on={ws.tab === 'prepare'}
					onclick={() => ws && (ws.tab = 'prepare')}>Prepare</button
				>
				<button
					role="tab"
					aria-selected={ws.tab === 'preview'}
					class:on={ws.tab === 'preview'}
					onclick={() => ws && (ws.tab = 'preview')}>Preview</button
				>
			</div>
			{#if ws.tab === 'prepare'}
				<div class="add">
					<button class="mini" aria-expanded={addOpen} onclick={() => (addOpen = !addOpen)}
						>+ Add</button
					>
					{#if addOpen}
						<div class="add-menu" role="menu">
							{#each models as m (m.id)}
								<button
									role="menuitem"
									onclick={() => (
										(addOpen = false),
										ws?.addModel(m.id, m.currentVersionId!, m.name)
									)}>{m.name}</button
								>
							{:else}
								<span class="hint">No models in this project yet.</span>
							{/each}
							<button role="menuitem" onclick={() => ((addOpen = false), fileInput?.click())}
								>A file (STL, 3MF, OBJ)…</button
							>
						</div>
					{/if}
					<input
						bind:this={fileInput}
						type="file"
						accept={SLICER_ACCEPT}
						hidden
						onchange={(e) => {
							const f = e.currentTarget.files?.[0];
							e.currentTarget.value = '';
							if (f) void ws?.addFile(f);
						}}
					/>
				</div>
				<div class="seg" role="radiogroup" aria-label="Gizmo">
					<button
						role="radio"
						aria-checked={ws.gizmo === 'translate'}
						class:on={ws.gizmo === 'translate'}
						title="Move (M)"
						onclick={() => ws && (ws.gizmo = 'translate')}>Move</button
					>
					<button
						role="radio"
						aria-checked={ws.gizmo === 'rotate'}
						class:on={ws.gizmo === 'rotate'}
						title="Rotate (R)"
						onclick={() => ws && (ws.gizmo = 'rotate')}>Rotate</button
					>
					<button
						role="radio"
						aria-checked={ws.gizmo === 'scale'}
						class:on={ws.gizmo === 'scale'}
						title="Scale (S)"
						onclick={() => ws && (ws.gizmo = 'scale')}>Scale</button
					>
				</div>
				<label class="check" title="Move by 1 mm, turn by 15°, scale by 5 %"
					><input type="checkbox" bind:checked={ws.snapping} /> Snap</label
				>
				{#if ws.can('arrange')}
					<button
						class="mini"
						disabled={!!ws.busy}
						onclick={() => ws?.arrange(false)}
						title="Arrange this plate">Arrange</button
					>
					{#if ws.project.plates.length > 1}<button
							class="mini"
							disabled={!!ws.busy}
							onclick={() => ws?.arrange(true)}>Arrange all</button
						>{/if}
				{/if}
				{#if ws.can('orient')}<button
						class="mini"
						disabled={!!ws.busy}
						onclick={() => ws?.orient()}
						title="Turn the selection (or the plate) the best way up">Orient</button
					>{/if}
				{#if ws.busy}<span class="hint" role="status"><span class="spinner"></span>{ws.busy}</span
					>{/if}
			{/if}
		</div>

		<nav class="plates" aria-label="Plates">
			{#each ws.project.plates as p (p.index)}
				<button
					class:on={ws.plate === p.index}
					aria-current={ws.plate === p.index ? 'true' : undefined}
					onclick={() => choosePlate(p.index)}
				>
					{p.name || `Plate ${p.index}`}<small>{p.instances.length}</small>{#if p.locked}<span
							aria-label="locked"
						>
							🔒</span
						>{/if}
				</button>
			{/each}
			{#if ws.tab === 'prepare'}<button class="add-plate" onclick={newPlate} title="Add a plate"
					>+ Plate</button
				>{/if}
		</nav>

		<div class="sw-layout">
			<aside class="left">
				<PresetPanel {ws} />
				<ObjectList {ws} />
			</aside>
			<main class="sw-stage">
				<div class="stage-box" class:hidden={ws.tab !== 'prepare'}>
					<SlicerStage {ws} bind:scene />
				</div>
				{#if ws.tab === 'preview'}
					<div class="preview-box">
						{#if result?.stale}<p class="stale-note" role="status">
								The project changed since this plate was sliced.
							</p>{/if}
						{#if result?.result.preview}
							{#key `${result.result.plate}:${result.result.at}`}
								<GcodePreview
									jobId=""
									file={result.result.at}
									plate={result.result.plate}
									grams={result.result.sliced.grams}
									url={previewUrl(ws.id, ws.plate)}
								/>
							{/key}
						{:else if result}
							<p class="panel-empty">There is no toolpath preview for this plate.</p>
						{:else}
							<p class="panel-empty">Slice plate {ws.plate} to see its toolpaths.</p>
						{/if}
					</div>
				{/if}
			</main>
			<aside class="right">
				{#if ws.paint}<PaintPanel {ws} />{:else}<ObjectPanel {ws} />{/if}
				<SlicePanel {ws} snapshot={(plate) => scene?.snapshot(plate) ?? null} />
				<PlatePanel {ws} />
			</aside>
		</div>
	{/if}
</div>

<style>
	.sw {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.sw-top {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}
	.crumbs {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		flex-wrap: wrap;
	}
	.crumbs a {
		color: var(--muted);
		text-decoration: none;
		font-size: 13px;
	}
	h1 {
		margin: 0;
		font-size: 20px;
		overflow-wrap: anywhere;
	}
	.save {
		font-size: 12px;
		color: var(--muted);
	}
	.save.bad {
		color: var(--err-text);
	}
	.top-actions,
	.toolbar-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}
	.seg {
		display: inline-flex;
		border: 1px solid var(--line);
		border-radius: 10px;
		overflow: hidden;
	}
	.seg button {
		padding: 5px 11px;
		border: 0;
		background: none;
		color: var(--muted);
		font-size: 12.5px;
		cursor: pointer;
	}
	.seg button.on {
		background: rgb(var(--hi) / 0.09);
		color: var(--text);
	}
	.check {
		display: inline-flex;
		gap: 5px;
		align-items: center;
		font-size: 12.5px;
	}
	.hint {
		font-size: 12px;
		color: var(--muted);
	}
	.add {
		position: relative;
	}
	.add-menu {
		position: absolute;
		z-index: 20;
		top: calc(100% + 4px);
		left: 0;
		display: grid;
		min-width: 220px;
		max-height: 320px;
		overflow: auto;
		padding: 6px;
		border: 1px solid var(--line-strong);
		border-radius: 12px;
		background: var(--menu);
		box-shadow: 0 12px 30px rgb(0 0 0 / 0.35);
	}
	.add-menu button {
		padding: 6px 8px;
		border: 0;
		border-radius: 8px;
		background: none;
		color: var(--text);
		text-align: left;
		font-size: 13px;
		cursor: pointer;
	}
	.add-menu button:hover {
		background: rgb(var(--hi) / 0.07);
	}
	.plates {
		display: flex;
		gap: 4px;
		overflow-x: auto;
		padding-bottom: 2px;
	}
	.plates button {
		display: inline-flex;
		gap: 6px;
		align-items: baseline;
		padding: 5px 11px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: none;
		color: var(--muted);
		font-size: 12.5px;
		white-space: nowrap;
		cursor: pointer;
	}
	.plates button.on {
		border-color: var(--cyan);
		color: var(--text);
	}
	.plates small {
		color: var(--dim);
	}
	.sw-layout {
		display: grid;
		grid-template-columns: minmax(230px, 280px) minmax(0, 1fr) minmax(260px, 320px);
		gap: 10px;
		align-items: start;
	}
	.left,
	.right {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
		min-width: 0;
	}
	.sw-stage {
		position: sticky;
		top: 10px;
		min-width: 0;
		height: calc(100vh - 190px);
		min-height: 420px;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--panel);
		overflow: hidden;
	}
	.stage-box {
		width: 100%;
		height: 100%;
	}
	.stage-box.hidden {
		display: none;
	}
	.stale-note {
		margin: 0 0 6px;
		font-size: 12px;
		color: var(--err-text);
	}
	.preview-box {
		height: 100%;
		overflow: auto;
		padding: 8px;
	}
	@media (max-width: 1100px) {
		.sw-layout {
			grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
		}
		.left {
			grid-column: 1 / -1;
			grid-row: 2;
			grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		}
	}
	@media (max-width: 760px) {
		.sw-layout {
			grid-template-columns: minmax(0, 1fr);
		}
		.left {
			grid-row: auto;
		}
		.sw-stage {
			position: static;
			height: 55vh;
			min-height: 320px;
		}
	}
</style>
