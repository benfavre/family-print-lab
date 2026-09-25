<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { actions, download, openMenu, projectHref } from '$lib/client/actions';
	import {
		aiEdit,
		decodeStl,
		fileUrl,
		getDetail,
		lacksSmallThumbnail,
		loadMesh,
		modelHref,
		preview,
		uploadThumbnail
	} from '$lib/client/models';
	import type { Analysis, Bounds, ModelViewer as Viewer, PickMode } from '$lib/client/viewer';
	import { fitFactor, type CheckFix } from '$lib/client/printcheck';
	import type {
		Diagnostic,
		ModelDetail,
		ModelVersion,
		Parameter,
		ParamValues
	} from '$lib/shared/cad';
	import { stamp } from '$lib/client/format';
	import type { AiProviderId } from '$lib/shared/integrations';
	import ModelViewer from '../ModelViewer.svelte';
	import ScadEditor from '../ScadEditor.svelte';
	import ParamsPanel from './ParamsPanel.svelte';
	import AiPanel, { type AiTurn } from './AiPanel.svelte';
	import MeshTools from './MeshTools.svelte';
	import Versions from './Versions.svelte';
	import PrintCheck from './PrintCheck.svelte';

	let { modelId }: { modelId: string } = $props();
	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);

	// ---------- Loaded state ----------
	let detail = $state<ModelDetail | null>(null);
	let loadError = $state('');
	const summary = $derived(lab.ws.models.find((m) => m.id === modelId));
	const project = $derived(lab.project(summary?.projectId ?? detail?.model.projectId));
	const kind = $derived(detail?.model.kind);
	const current = $derived(detail?.current);

	// ---------- Viewer ----------
	let viewer = $state<Viewer | null>(null);
	let viewerPanel = $state<ReturnType<typeof ModelViewer>>();
	let bounds = $state<Bounds | null>(null);
	let analysis = $state<Analysis | null>(null);
	let overhangs = $state(false);
	let mode = $state<PickMode>('orbit');
	let viewing = $state<ModelVersion | null>(null);
	let comparing = $state<ModelVersion | null>(null);
	let meshTools = $state<ReturnType<typeof MeshTools>>();

	// ---------- Parametric editing ----------
	let source = $state('');
	let params = $state<ParamValues>({});
	let parameters = $state<Parameter[]>([]);
	let diagnostics = $state<Diagnostic[]>([]);
	let echo = $state<string[]>([]);
	let renderMs = $state<number | null>(null);
	let rendering = $state(false);
	let tab = $state<'params' | 'code' | 'ai'>('params');
	let note = $state('');
	let editor = $state<ReturnType<typeof ScadEditor>>();
	let busy = $state(false);

	// ---------- AI ----------
	let aiTurns = $state<AiTurn[]>([]);
	let aiBusy = $state(false);
	let aiTaskId = $state<string | null>(null);
	let beforeAi = $state<{ source: string; params: ParamValues } | null>(null);

	const keyOf = (s: string, p: ParamValues) => JSON.stringify([s, p]);
	const dirty = $derived(
		!!(
			kind === 'parametric' &&
			current &&
			keyOf(source, params) !== keyOf(current.source, current.params)
		)
	);
	const errors = $derived(diagnostics.filter((d) => d.level === 'error'));
	const warnings = $derived(diagnostics.filter((d) => d.level === 'warning'));
	const blenderReady = $derived(
		!!lab.integrations?.items.find((i) => i.id === 'blender')?.available
	);
	const others = $derived(
		lab.ws.models.filter(
			(m) => m.projectId === summary?.projectId && m.id !== modelId && m.currentVersionId
		)
	);

	// ---------- Loading ----------
	let loadSeq = 0;
	async function load(initial = false) {
		const seq = ++loadSeq;
		try {
			const d = await getDetail(modelId);
			if (seq !== loadSeq) return;
			const keepEdits = !initial && dirty;
			detail = d;
			loadError = '';
			if (d.model.kind === 'parametric' && d.current && !keepEdits) {
				source = d.current.source;
				params = { ...d.current.params };
				parameters = d.parameters;
				lastKey = keyOf(source, params);
			}
			if (d.current && !keepEdits) await show(d.current, !initial);
		} catch (error) {
			loadError = (error as Error).message;
		}
	}

	/** Loads a stored version into the viewer; saves a thumbnail for the current version if it has none. */
	async function show(v: ModelVersion, keepCamera: boolean) {
		try {
			const mesh = await loadMesh(modelId, v.id);
			viewer?.load(mesh, keepCamera && viewer.hasPart);
			syncBounds();
			if (v.id === detail?.model.currentVersionId) {
				if (!v.hasThumbnail) void thumbnail(v);
				// Older versions only have the big PNG: add the small one the app shows.
				else
					void lacksSmallThumbnail(modelId, v.id).then((old) => {
						if (old) void thumbnail(v);
					});
			}
		} catch (error) {
			ui.toast((error as Error).message, 'error');
		}
	}

	async function thumbnail(v: ModelVersion) {
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		const pics = await viewer?.thumbnail();
		if (pics) {
			await uploadThumbnail(modelId, v.id, pics);
			v.hasThumbnail = true;
		}
	}

	function syncBounds() {
		bounds = viewer?.bounds() ?? null;
		analysis = viewer?.analysis() ?? null;
		viewerPanel?.refresh();
	}

	// Wait for the viewer before the first load, so the mesh has somewhere to go.
	let started = false;
	$effect(() => {
		if (viewer && !started) {
			started = true;
			void load(true);
		}
	});

	// Follow changes made elsewhere: another tab, a Blender save, the model being deleted.
	$effect(() => {
		const cur = summary?.currentVersionId;
		const ver = summary?.version;
		untrack(() => {
			if (detail && (cur !== detail.model.currentVersionId || ver !== detail.model.version))
				void load();
		});
	});
	// While Blender is open, watch for the session closing.
	$effect(() => {
		void lab.ws.changeId;
		untrack(() => detail?.editing && void load());
	});

	// ---------- Live preview (parametric) ----------
	let lastKey = '';
	let previewAbort: AbortController | null = null;
	$effect(() => {
		if (kind !== 'parametric' || !detail) return;
		const key = keyOf(source, params);
		if (key === lastKey) return;
		const timer = setTimeout(() => runPreview(key), 260);
		return () => clearTimeout(timer);
	});

	async function runPreview(key: string) {
		previewAbort?.abort();
		const abort = (previewAbort = new AbortController());
		lastKey = key;
		rendering = true;
		try {
			const r = await preview(source, $state.snapshot(params), abort.signal);
			diagnostics = r.diagnostics;
			echo = r.echo;
			renderMs = r.ms;
			parameters = r.parameters;
			if (r.stl) {
				viewer?.load(decodeStl(r.stl), viewer.hasPart);
				viewing = null;
				syncBounds();
			}
		} catch (error) {
			if ((error as Error).name === 'AbortError') return;
			diagnostics = [{ level: 'error', message: (error as Error).message, line: null }];
		} finally {
			if (previewAbort === abort) rendering = false;
		}
	}

	// ---------- Saving ----------
	async function save() {
		if (kind !== 'parametric' || !dirty || errors.length || busy) return;
		busy = true;
		const fromAi = !!beforeAi;
		const summaryText = fromAi ? aiTurns.at(-1)?.result?.summary : '';
		const res = await lab.call<{ versionId: string }>(
			'POST',
			`/api/models/${modelId}/versions`,
			{
				source,
				params: $state.snapshot(params),
				note: note.trim() || (fromAi ? `AI: ${summaryText}`.slice(0, 200) : undefined),
				origin: fromAi ? 'ai' : 'editor',
				taskId: fromAi ? (aiTurns.at(-1)?.taskId ?? undefined) : undefined
			},
			'Saved as a new version.'
		);
		busy = false;
		if (!res) return;
		note = '';
		if (fromAi) {
			const last = aiTurns.at(-1);
			if (last) last.kept = true;
			beforeAi = null;
		}
	}

	async function restore(v: ModelVersion) {
		if (
			dirty &&
			!(await ui.ask(
				'Discard unsaved changes?',
				`Restoring v${v.number} replaces what is in the editor.`,
				'Restore'
			))
		)
			return;
		busy = true;
		lastKey = '';
		const ok = await lab.call(
			'POST',
			`/api/models/${modelId}/restore`,
			{ versionId: v.id },
			`Restored v${v.number}.`
		);
		busy = false;
		if (ok) {
			viewing = null;
			source = v.source;
			params = { ...v.params };
			beforeAi = null;
		}
	}

	async function view(v: ModelVersion | null) {
		viewing = v;
		if (v) await show(v, true);
		else if (kind === 'parametric' && dirty) {
			lastKey = '';
			void runPreview(keyOf(source, params));
		} else if (current) await show(current, true);
	}

	async function compare(v: ModelVersion | null) {
		comparing = v;
		if (!v) return viewer?.setCompare(null);
		try {
			const mesh = await loadMesh(modelId, v.id);
			if (comparing?.id === v.id) viewer?.setCompare(mesh);
		} catch (error) {
			ui.toast((error as Error).message, 'error');
		}
	}
	// A new current version (or a restore) ends the comparison.
	$effect(() => {
		void detail?.model.currentVersionId;
		untrack(() => comparing && compare(null));
	});

	async function rename(name: string) {
		if (!summary || !name.trim() || name.trim() === summary.name) return;
		await lab.call('PATCH', `/api/models/${modelId}`, { name: name.trim() }, 'Renamed.');
	}

	// ---------- AI ----------
	async function ask(
		instruction: string,
		image: { mediaType: string; data: string } | null,
		provider: AiProviderId | null
	) {
		aiTurns.push({
			instruction,
			result: null,
			error: null,
			kept: false,
			undone: false,
			taskId: null
		});
		const turn = aiTurns[aiTurns.length - 1];
		aiBusy = true;
		try {
			// The change runs as a background task; if this page closes it waits in Activity.
			const { task } = await aiEdit(modelId, {
				source,
				instruction,
				params: $state.snapshot(params),
				image,
				provider: provider ?? undefined
			});
			turn.taskId = aiTaskId = task.id;
			ui.watching.add(task.id);
			const done = await lab.waitForTask(task.id);
			if (done.status === 'done' && done.suggestion) {
				const result = done.suggestion;
				turn.result = result;
				beforeAi ??= { source, params: $state.snapshot(params) };
				source = result.source;
				params = {};
				if (!result.render.ok) diagnostics = result.render.diagnostics;
			} else
				turn.error =
					done.status === 'cancelled' ? 'Stopped.' : done.error || 'The AI did not answer.';
		} catch (error) {
			turn.error = (error as Error).message;
		} finally {
			aiBusy = false;
			aiTaskId = null;
		}
	}
	function undoAi() {
		if (!beforeAi) return;
		source = beforeAi.source;
		params = beforeAi.params;
		beforeAi = null;
		const last = aiTurns.at(-1);
		if (last) last.undone = true;
	}

	// ---------- Mesh tools & Blender ----------
	const OP_DONE: Record<string, string> = {
		scale: 'Scaled.',
		rotate: 'Rotated.',
		mirror: 'Mirrored.',
		center: 'Centered on the bed.',
		layFlat: 'Laid flat.',
		autoOrient: 'Turned to the orientation that needs the least support.',
		cut: 'Cut.',
		drill: 'Hole drilled.',
		combine: 'Combined.'
	};
	async function op(o: Record<string, unknown>) {
		busy = true;
		const res = await lab.call('POST', `/api/models/${modelId}/ops`, o, OP_DONE[o.op as string]);
		busy = false;
		mode = 'orbit';
		return !!res;
	}

	/** One-click fixes offered by the print check. */
	function fix(f: CheckFix) {
		if (f === 'overhangs') overhangs = !overhangs;
		else if (f === 'orient') void op({ op: 'autoOrient' });
		else if (f === 'repair') void blender('repair');
		else if (f === 'fit' && bounds) {
			const k = fitFactor(bounds.size);
			if (k < 1) void op({ op: 'scale', factor: [k, k, k] });
		}
	}

	async function blender(action: 'repair' | 'decimate' | 'open', ratio?: number) {
		busy = true;
		const res = await lab.call<{ modelId?: string; report?: Record<string, number> }>(
			'POST',
			`/api/models/${modelId}/blender`,
			{ action, ratio }
		);
		busy = false;
		if (!res) return;
		if (action === 'open') {
			if (res.modelId && res.modelId !== modelId) {
				ui.toast('Opened a mesh copy in Blender. Save there to update it.');
				await goto(modelHref(summary!.projectId, res.modelId));
			} else {
				ui.toast('Opening Blender… Save there (Ctrl+S) to bring changes back.');
				void load();
			}
		} else if (action === 'repair') {
			const r = res.report ?? {};
			ui.toast(
				`Repaired: ${r.holes_filled ?? 0} holes filled, ${r.non_manifold_edges ?? 0} open edges left.`
			);
		} else
			ui.toast(
				`Simplified: ${(res.report?.faces_before ?? 0).toLocaleString()} → ${(res.report?.faces_after ?? 0).toLocaleString()} triangles.`
			);
	}

	async function meshCopy() {
		busy = true;
		const res = await lab.call<{ id: string }>(
			'POST',
			`/api/models/${modelId}/mesh-copy`,
			undefined,
			'Made a mesh copy. The parametric original is unchanged.'
		);
		busy = false;
		if (res && summary) await goto(modelHref(summary.projectId, res.id));
	}

	function more(e: MouseEvent) {
		if (!summary) return;
		const btn = e.currentTarget as HTMLElement;
		const rect = btn.getBoundingClientRect();
		openMenu(
			app,
			summary.name,
			[
				...(kind === 'parametric'
					? [
							{ label: 'Make mesh copy (for mesh tools)', run: meshCopy },
							{ label: 'Open a copy in Blender', run: () => blender('open') }
						]
					: [{ label: 'Open in Blender', run: () => blender('open') }]),
				...(current
					? [
							{
								label: 'Download 3MF',
								run: () => download(`${fileUrl(modelId, current.id, 'model.3mf')}?download`)
							}
						]
					: []),
				{ label: '', separator: true },
				{
					label: 'Delete model…',
					danger: true,
					run: async () => {
						if (summary && (await act.deleteModel(summary))) {
							leaving = true;
							await goto(projectHref(summary.projectId));
						}
					}
				}
			],
			rect.right - 220,
			rect.bottom + 6,
			btn
		);
	}

	// ---------- Navigation guard and shortcuts ----------
	let leaving = false;
	beforeNavigate((nav) => {
		if (leaving || !dirty) return;
		if (nav.type === 'leave') return nav.cancel();
		nav.cancel();
		void ui
			.ask(
				'Leave without saving?',
				'Your changes to this model are not saved as a version yet.',
				'Leave'
			)
			.then((ok) => {
				if (ok && nav.to) {
					leaving = true;
					// eslint-disable-next-line svelte/no-navigation-without-resolve -- the URL came from SvelteKit's own navigation
					void goto(nav.to.url);
				}
			});
	});

	// Undo/redo step through saved versions (every version is kept, so nothing is lost).
	const byNumber = $derived(detail ? [...detail.versions].sort((a, b) => a.number - b.number) : []);
	const undoTarget = $derived(
		current && !dirty ? byNumber.filter((v) => v.number < current.number).at(-1) : undefined
	);
	const redoTarget = $derived(
		current && !dirty ? byNumber.find((v) => v.number > current.number) : undefined
	);
	async function step(v: ModelVersion | undefined, verb: string) {
		if (!v || busy) return;
		busy = true;
		lastKey = '';
		const ok = await lab.call(
			'POST',
			`/api/models/${modelId}/restore`,
			{ versionId: v.id },
			`${verb}: back to v${v.number} (${v.note || 'no note'}).`
		);
		busy = false;
		if (ok) {
			viewing = null;
			source = v.source;
			params = { ...v.params };
		}
	}

	function onKey(e: KeyboardEvent) {
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === 's') {
			e.preventDefault();
			void save();
		}
		const typing = (e.target as HTMLElement).closest(
			'input, textarea, select, .cm-editor, [contenteditable]'
		);
		if (mod && !typing && !document.querySelector('dialog[open]')) {
			const key = e.key.toLowerCase();
			if (key === 'z' && !e.shiftKey) {
				e.preventDefault();
				void step(undoTarget, 'Undone');
			} else if ((key === 'z' && e.shiftKey) || key === 'y') {
				e.preventDefault();
				void step(redoTarget, 'Redone');
			}
		}
		if (e.key === 'Escape' && mode !== 'orbit') mode = 'orbit';
	}

	function gotoLine(line: number | null) {
		if (!line) return;
		tab = 'code';
		requestAnimationFrame(() => editor?.goto(line));
	}

	onMount(() => () => {
		previewAbort?.abort();
		// A change still running keeps going in the background; let its completion raise a toast.
		for (const t of aiTurns) if (t.taskId) ui.watching.delete(t.taskId);
	});

	const events = {
		onFace: (normal: [number, number, number]) => void op({ op: 'layFlat', normal }),
		onPoint: (p: [number, number, number], n: [number, number, number]) =>
			meshTools?.pickPoint(p, n)
	};
</script>

<svelte:window onkeydown={onKey} />

<div class="bench" class:code-wide={tab === 'code' && kind === 'parametric'}>
	<header class="bench-head">
		<a class="crumb" href={project ? projectHref(project.id) : resolve('/')}
			><span aria-hidden="true">←</span> {project?.title ?? 'Projects'}</a
		>
		{#if summary}
			<input
				class="bench-name"
				value={summary.name}
				maxlength="80"
				aria-label="Model name"
				onchange={(e) => rename(e.currentTarget.value)}
				onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
			/>
			<span class="kind-chip" class:mesh={kind === 'mesh'}
				>{kind === 'mesh' ? 'Mesh' : 'Parametric'}</span
			>
			<span class="save-state" class:dirty>
				{#if dirty}● Unsaved changes{:else if current}v{current.number} · {stamp(
						current.createdAt
					)}{/if}
			</span>
			<div class="bench-actions">
				{#if kind === 'parametric'}
					<input
						class="note"
						bind:value={note}
						maxlength="200"
						placeholder="What changed? (optional)"
						aria-label="Version note"
					/>
					<button
						class="primary"
						disabled={!dirty || !!errors.length || busy || rendering}
						onclick={save}
						title="Save as a new version (Ctrl+S)">Save version</button
					>
				{/if}
				{#if current && blenderReady}
					{#if detail?.editing}
						<span
							class="blender-live"
							title="Save in Blender (Ctrl+S) to bring changes back as a new version"
							><span class="pulse"></span>Editing in Blender</span
						>
					{:else}
						<button
							class="secondary blender-btn"
							disabled={busy || dirty}
							title={kind === 'parametric'
								? 'Opens a mesh copy in Blender; saves there come back as new versions'
								: 'Sculpt and model in Blender; each save comes back as a new version'}
							onclick={() => blender('open')}
							><span aria-hidden="true">◉</span> Open in Blender</button
						>
					{/if}
				{/if}
				{#if current}
					<button
						class="secondary"
						onclick={() =>
							ui.openEditor('job', null, {
								projectId: summary.projectId,
								modelVersionId: current.id
							})}
						disabled={dirty}
						title={dirty ? 'Save first' : 'Queue this version'}>Queue print</button
					>
					<button
						class="secondary"
						onclick={() => download(`${fileUrl(modelId, current.id, 'model.stl')}?download`)}
						disabled={dirty}
						title="Download the current version for Bambu Studio">⤓ STL</button
					>
				{/if}
				<button
					class="icon-button"
					aria-label="Undo"
					title={undoTarget ? `Undo: back to v${undoTarget.number} (Ctrl+Z)` : 'Nothing to undo'}
					disabled={!undoTarget || busy}
					onclick={() => step(undoTarget, 'Undone')}>↶</button
				>
				<button
					class="icon-button"
					aria-label="Redo"
					title={redoTarget
						? `Redo: forward to v${redoTarget.number} (Ctrl+Shift+Z)`
						: 'Nothing to redo'}
					disabled={!redoTarget || busy}
					onclick={() => step(redoTarget, 'Redone')}>↷</button
				>
				<button class="icon-button" aria-label="More model actions" onclick={more}>⋯</button>
			</div>
		{/if}
	</header>

	{#if loadError && !detail}
		<section class="panel gone">
			<h2>This model is not available</h2>
			<p>{loadError}</p>
			{#if project}<a href={projectHref(project.id)}>Back to {project.title}</a>{/if}
		</section>
	{:else}
		<div class="bench-body">
			<aside class="bench-left panel">
				{#if kind === 'parametric'}
					<div class="bench-tabs" role="tablist" aria-label="Editing mode">
						<button role="tab" aria-selected={tab === 'params'} onclick={() => (tab = 'params')}
							>Parameters{#if Object.keys(params).length}<span class="badge"
									>{Object.keys(params).length}</span
								>{/if}</button
						>
						<button role="tab" aria-selected={tab === 'code'} onclick={() => (tab = 'code')}
							>Code{#if errors.length}<span class="badge err">{errors.length}</span>{/if}</button
						>
						<button
							role="tab"
							aria-selected={tab === 'ai'}
							class="ai-tab"
							onclick={() => (tab = 'ai')}
							>✦ AI{#if aiBusy}<span class="badge ai-dot">…</span>{/if}</button
						>
					</div>
					<div class="bench-pane" class:flush={tab === 'code'}>
						{#if tab === 'params'}
							<ParamsPanel {parameters} values={params} onchange={(v) => (params = v)} />
						{:else if tab === 'code'}
							<ScadEditor
								bind:this={editor}
								value={source}
								{diagnostics}
								onchange={(v) => (source = v)}
							/>
						{:else}
							<AiPanel
								busy={aiBusy}
								turns={aiTurns}
								pending={!!beforeAi}
								stage={lab.taskFor(aiTaskId)?.stage ?? ''}
								onask={ask}
								oncancel={() => aiTaskId && lab.taskAction(aiTaskId, 'cancel')}
								onkeep={save}
								onundo={undoAi}
							/>
						{/if}
					</div>
				{:else if kind === 'mesh'}
					<div class="bench-pane">
						<MeshTools
							bind:this={meshTools}
							bind:mode
							{bounds}
							{viewer}
							{others}
							{busy}
							blender={blenderReady || !lab.integrations}
							editingInBlender={!!detail?.editing}
							onop={op}
							onblender={blender}
						/>
					</div>
				{:else}
					<p class="panel-empty">Loading…</p>
				{/if}
			</aside>

			<div class="bench-center">
				<ModelViewer
					bind:this={viewerPanel}
					bind:viewer
					bind:overhangs
					{mode}
					busy={rendering || busy}
					{events}
					empty={detail ? 'This version has no geometry.' : 'Loading…'}
				>
					{#snippet tools()}
						<div class="seg" role="group" aria-label="Tools">
							<button
								type="button"
								aria-pressed={mode === 'measure'}
								onclick={() => (mode = mode === 'measure' ? 'orbit' : 'measure')}
								title="Measure between two points">Measure</button
							>
						</div>
						{#if comparing}
							<span class="viewing-banner compare"
								>Overlay: v{comparing.number}
								<button
									type="button"
									class="mini icon"
									aria-label="Stop comparing"
									onclick={() => compare(null)}>×</button
								></span
							>
						{/if}
						{#if viewing}
							<span class="viewing-banner"
								>Viewing v{viewing.number}
								<button type="button" class="mini" onclick={() => restore(viewing!)}>Restore</button
								>
								<button
									type="button"
									class="mini icon"
									aria-label="Back to the editor"
									onclick={() => view(null)}>×</button
								></span
							>
						{/if}
					{/snippet}
				</ModelViewer>
				{#if kind === 'parametric' && (rendering || diagnostics.length || echo.length || renderMs !== null)}
					<div class="problems" class:has-errors={errors.length}>
						{#if rendering}
							<span class="muted">Rendering…</span>
						{:else if errors.length}
							{#each errors as d, i (i)}
								<button type="button" class="problem err" onclick={() => gotoLine(d.line)}
									>✕ {d.line ? `Line ${d.line}: ` : ''}{d.message}</button
								>
							{/each}
						{:else if renderMs !== null}
							<span class="ok">✓ Renders</span><span class="muted">{renderMs} ms · manifold</span>
						{/if}
						{#each warnings.slice(0, 4) as d, i (i)}
							<button type="button" class="problem warn" onclick={() => gotoLine(d.line)}
								>⚠ {d.line ? `Line ${d.line}: ` : ''}{d.message}</button
							>
						{/each}
						{#each echo.slice(0, 3) as line, i (i)}<code class="echo">{line}</code>{/each}
					</div>
				{/if}
			</div>

			<aside class="bench-right panel">
				<PrintCheck
					{bounds}
					{analysis}
					mesh={kind === 'mesh'}
					busy={busy || !!detail?.editing}
					blender={blenderReady}
					overhangsOn={overhangs}
					onfix={fix}
				/>
				<header class="panel-head">
					<h2>Versions</h2>
					<span class="count">{detail?.versions.length ?? 0}</span>
				</header>
				{#if detail}
					<Versions
						{modelId}
						versions={detail.versions}
						currentId={detail.model.currentVersionId}
						viewingId={viewing?.id ?? null}
						comparingId={comparing?.id ?? null}
						oncompare={compare}
						{busy}
						onview={view}
						onrestore={restore}
					/>
				{/if}
				{#if summary}
					{@const jobs = lab.ws.jobs.filter(
						(j) => j.modelVersionId && detail?.versions.some((v) => v.id === j.modelVersionId)
					)}
					{#if jobs.length}
						<h2 class="sub-title">Prints of this model</h2>
						<ul class="bench-jobs">
							{#each jobs as j (j.id)}
								<li data-job={j.id}>
									<span class="dot s-{j.status}"></span>{j.revision || 'Print'} · v{detail?.versions.find(
										(v) => v.id === j.modelVersionId
									)?.number}<span class="muted">{j.status}</span>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			</aside>
		</div>
	{/if}
</div>

<style>
	.bench {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 0;
		height: calc(100dvh - var(--topbar-h, 64px));
	}
	.bench-head {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		min-height: 36px;
	}
	.crumb {
		font-size: 13px;
		color: var(--muted);
		text-decoration: none;
		white-space: nowrap;
	}
	.crumb:hover {
		color: var(--text);
	}
	.bench-name {
		font: 600 18px var(--sans);
		letter-spacing: -0.02em;
		color: var(--text);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--r-sm);
		padding: 3px 6px;
		min-width: 120px;
		width: clamp(160px, 24vw, 360px);
	}
	/* Where supported, the name box hugs the name so the badges sit right after it. */
	@supports (field-sizing: content) {
		.bench-name {
			width: auto;
			field-sizing: content;
			max-width: min(420px, 40vw);
		}
	}
	.bench-name:hover {
		border-color: var(--line);
	}
	.bench-name:focus {
		outline: none;
		border-color: rgb(var(--c1) / 0.6);
	}
	.kind-chip {
		font: 500 10.5px var(--mono);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 3px 8px;
		border-radius: 999px;
		color: var(--cyan);
		box-shadow: 0 0 0 1px rgb(var(--c1) / 0.4) inset;
	}
	.kind-chip.mesh {
		color: var(--violet);
		box-shadow: 0 0 0 1px rgb(var(--c2) / 0.4) inset;
	}
	.save-state {
		font-size: 12px;
		color: var(--dim);
		white-space: nowrap;
	}
	.save-state.dirty {
		color: var(--amber);
	}
	.bench-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.note {
		height: 32px;
		width: 220px;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-md);
		background: rgb(var(--hi) / 0.03);
		padding: 0 10px;
		color: var(--text);
		font-size: 13px;
	}
	.note:focus {
		outline: none;
		border-color: rgb(var(--c1) / 0.6);
	}
	.bench-body {
		display: grid;
		grid-template-columns: 380px minmax(0, 1fr) 280px;
		gap: 12px;
		flex: 1;
		min-height: 480px;
		transition: grid-template-columns 0.25s ease;
	}
	.bench.code-wide .bench-body {
		grid-template-columns: minmax(460px, 38%) minmax(0, 1fr) 260px;
	}
	.bench-left,
	.bench-right {
		display: flex;
		flex-direction: column;
		min-height: 0;
		padding: 12px;
	}
	.bench-right {
		overflow-y: auto;
		scrollbar-width: thin;
		padding-bottom: 64px; /* room for the floating assistant button */
	}
	.bench-tabs {
		display: flex;
		gap: 2px;
		padding: 2px;
		border-radius: var(--r-md);
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
		margin-bottom: 12px;
		flex-shrink: 0;
	}
	.bench-tabs button {
		flex: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 0;
		border-radius: 8px;
		padding: 6px 8px;
		background: transparent;
		color: var(--muted);
		font-size: 12.5px;
		font-weight: 500;
	}
	.bench-tabs button[aria-selected='true'] {
		background: rgb(var(--hi) / 0.09);
		color: var(--text);
	}
	.bench-tabs .ai-tab[aria-selected='true'] {
		background: rgb(var(--c2) / 0.16);
	}
	.badge {
		font: 500 10px var(--mono);
		padding: 0 5px;
		border-radius: 999px;
		background: rgb(var(--c1) / 0.2);
		color: var(--text);
	}
	.badge.err {
		background: rgb(var(--c5) / 0.3);
	}
	.badge.ai-dot {
		background: rgb(var(--c2) / 0.3);
	}
	.bench-pane {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		scrollbar-width: thin;
		padding-right: 2px;
	}
	.bench-pane.flush {
		overflow: hidden;
		margin: 0 -12px -12px;
		border-top: 1px solid var(--line);
	}
	.bench-center {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-height: 0;
		min-width: 0;
	}
	.bench-center > :global(.viewer) {
		flex: 1;
	}
	.problems {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
		min-height: 30px;
		padding: 6px 10px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: var(--panel);
		font-size: 12px;
		max-height: 96px;
		overflow-y: auto;
	}
	.problems.has-errors {
		border-color: rgb(var(--c5) / 0.45);
	}
	.problem {
		border: 0;
		background: transparent;
		padding: 0;
		text-align: left;
		font: inherit;
		cursor: pointer;
	}
	.problem.err {
		color: var(--err-text);
	}
	.problem.warn {
		color: var(--amber);
	}
	.problem:hover {
		text-decoration: underline;
	}
	.ok {
		color: var(--lime);
	}
	.muted {
		color: var(--dim);
	}
	.echo {
		font-size: 11px;
		color: var(--muted);
	}
	.seg {
		display: inline-flex;
		border-radius: var(--r-sm);
		background: rgb(var(--base) / 0.72);
		backdrop-filter: blur(8px);
		box-shadow: 0 0 0 1px var(--line) inset;
		padding: 2px;
	}
	.seg button {
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		padding: 4px 9px;
		border-radius: 6px;
	}
	.seg button[aria-pressed='true'] {
		color: var(--on-accent);
		background: var(--amber);
	}
	.viewing-banner {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 4px 3px 10px;
		border-radius: var(--r-sm);
		background: rgb(var(--base) / 0.8);
		box-shadow: 0 0 0 1px rgb(var(--c4) / 0.6) inset;
		color: var(--amber);
		font-size: 12px;
	}
	.sub-title {
		margin: 16px 0 8px !important;
		font-size: 12px !important;
		color: var(--muted);
	}
	.bench-jobs {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 12.5px;
	}
	.bench-jobs li {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.bench-jobs .muted {
		margin-left: auto;
		font-size: 11.5px;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--dim);
	}
	.dot.s-Succeeded {
		background: var(--lime);
	}
	.dot.s-Failed {
		background: var(--red);
	}
	.dot.s-Printing {
		background: var(--amber);
	}
	.dot.s-Queued {
		background: var(--cyan);
	}
	.blender-btn span {
		color: var(--amber);
	}
	.blender-live {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 12px;
		border-radius: var(--r-md);
		font-size: 13px;
		color: var(--lime);
		box-shadow: 0 0 0 1px rgb(var(--c3) / 0.4) inset;
	}
	.pulse {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--lime);
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
	.bench-actions .icon-button:disabled {
		cursor: default;
		opacity: 0.3;
	}
	.gone {
		max-width: 520px;
	}
	@media (max-width: 1280px) {
		.bench-body,
		.bench.code-wide .bench-body {
			grid-template-columns: 360px minmax(0, 1fr);
			grid-template-rows: minmax(0, 1fr) auto;
		}
		.bench-right {
			grid-column: 1 / -1;
			max-height: 320px;
		}
	}
	@media (max-width: 860px) {
		.bench {
			height: auto;
		}
		.bench-body,
		.bench.code-wide .bench-body {
			display: flex;
			flex-direction: column;
		}
		.bench-center {
			order: -1;
			height: 60vh;
		}
		.bench-left {
			max-height: 70vh;
		}
		.bench-pane.flush {
			min-height: 50vh;
		}
		.note {
			width: auto;
			flex: 1 0 180px;
		}
		/* One swipeable row of actions instead of orphaned buttons on a second line. */
		.bench-actions {
			margin-left: 0;
			width: 100%;
			flex-wrap: nowrap;
			overflow-x: auto;
			scrollbar-width: none;
			padding-bottom: 2px;
			mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
		}
		.bench-actions > :global(*) {
			flex-shrink: 0;
		}
		.bench-name {
			width: auto;
			flex: 1;
		}
	}
</style>
