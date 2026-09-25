<script lang="ts">
	import { untrack } from 'svelte';
	import {
		JOB_STATUSES,
		LAYER_HEIGHTS,
		MATERIALS,
		NOZZLES,
		PLATES,
		SUPPORTS,
		type JobStatus
	} from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import { fromLocalInput, toLocalInput, weight } from '$lib/client/format';
	import EditorShell from './EditorShell.svelte';
	import ExpandableText from './ExpandableText.svelte';

	let {
		id,
		preset,
		onclose
	}: { id: string | null; preset: Record<string, unknown>; onclose: () => void } = $props();
	const { lab, ui } = useApp();
	// The editor is recreated for each record ({#key}), so reading props once is intended.
	const existing = untrack(() => (id ? lab.ws.jobs.find((j) => j.id === id) : undefined));
	const initial = untrack(() => preset);
	const project =
		lab.project(String(existing?.projectId ?? initial.projectId ?? '')) ??
		lab.ownedProjects(ui.profile)[0] ??
		lab.ws.projects[0];
	const src: Record<string, unknown> = { ...initial, ...(existing ?? {}) };
	const str = (k: string, fallback: string) =>
		typeof src[k] === 'string' ? (src[k] as string) : fallback;
	const numOr = (k: string, fallback: number | null) =>
		typeof src[k] === 'number' ? (src[k] as number) : fallback;
	let f = $state({
		projectId: str('projectId', project?.id ?? ''),
		status: str('status', 'Queued') as JobStatus,
		revision: str('revision', ''),
		spoolId: str('spoolId', ''),
		material: str(
			'material',
			project?.material && MATERIALS.includes(project.material as never) ? project.material : 'PLA'
		),
		grams: numOr('grams', null),
		minutes: numOr('minutes', null),
		actualMinutes: numOr('actualMinutes', null),
		layerHeight: str('layerHeight', '0.20'),
		nozzle: str('nozzle', '0.4'),
		plate: str('plate', 'Textured PEI'),
		supports: str('supports', 'None'),
		infill: numOr('infill', 15),
		notes: str('notes', ''),
		printerTask: str('printerTask', ''),
		modelVersionId: str('modelVersionId', ''),
		startedAt: toLocalInput(src.startedAt as string | null),
		finishedAt: toLocalInput(src.finishedAt as string | null)
	});
	let busy = $state(false);
	let aiNote = $state('The AI reads the project and recommends slicer settings.');
	let aiBusy = $state(false);
	// Model versions of the chosen project, newest first, for linking the job to the exact geometry printed.
	const modelOptions = $derived(
		lab.ws.models
			.filter((m) => m.projectId === f.projectId)
			.flatMap((m) =>
				m.versions.map((v) => ({
					id: v.id,
					label: `${m.name} · v${v.number}${v.id === m.currentVersionId ? ' (current)' : ''}`
				}))
			)
	);
	const withCurrent = (list: readonly string[], value: string) =>
		value && !list.includes(value) ? [...list, value] : [...list];
	const num = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number(v));

	function onSpool() {
		const s = lab.spool(f.spoolId);
		if (s) f.material = s.material;
	}

	async function suggest() {
		if (!lab.ai.configured) return (aiNote = 'Set up the assistant first (see ✦ Ask the lab).');
		aiBusy = true;
		aiNote = 'Asking the AI…';
		try {
			const r = await fetch('/api/ai/settings', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ projectId: f.projectId, material: f.material })
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error);
			Object.assign(f, {
				layerHeight: data.settings.layerHeight,
				nozzle: data.settings.nozzle,
				plate: data.settings.plate,
				supports: data.settings.supports,
				infill: Math.min(100, Math.max(0, Math.round(data.settings.infill)))
			});
			aiNote = `✦ ${data.rationale}`;
		} catch (error) {
			aiNote = (error as Error).message || 'The assistant is unavailable.';
		} finally {
			aiBusy = false;
		}
	}

	async function save() {
		busy = true;
		const body = {
			...f,
			spoolId: f.spoolId || null,
			modelVersionId: f.modelVersionId || null,
			grams: num(f.grams),
			minutes: num(f.minutes),
			actualMinutes: num(f.actualMinutes),
			infill: num(f.infill),
			startedAt: fromLocalInput(f.startedAt),
			finishedAt: fromLocalInput(f.finishedAt)
		};
		if (!existing && !body.revision) delete (body as Partial<typeof body>).revision;
		const ok = existing
			? await lab.call(
					'PATCH',
					`/api/jobs/${existing.id}`,
					{ ...body, version: existing.version },
					'Saved.'
				)
			: await lab.call('POST', '/api/jobs', body, 'Added to the print queue.');
		busy = false;
		if (ok) onclose();
	}
	async function remove() {
		if (
			existing &&
			(await ui.ask('Delete this print job?', 'Any filament it used is returned to its spool.')) &&
			(await lab.call('DELETE', `/api/jobs/${existing.id}`, undefined, 'Print job deleted.'))
		)
			onclose();
	}
</script>

<EditorShell
	subject={lab.project(f.projectId)?.title ?? ''}
	id="job-editor"
	eyebrow="PRINT JOB"
	title={existing ? 'Print job' : 'Queue a print'}
	{busy}
	error=""
	saveLabel={existing ? 'Save changes' : 'Add to queue'}
	onsubmit={save}
	{onclose}
	ondelete={existing ? remove : undefined}
>
	<div class="ai-inline">
		<button type="button" class="mini ai" disabled={aiBusy} onclick={suggest}
			>✦ Suggest settings</button
		><small>{aiNote}</small>
	</div>
	<div class="fields-row">
		<label class="field"
			>Project<select bind:value={f.projectId}
				>{#each lab.ws.projects as p (p.id)}<option value={p.id}>{p.title}</option>{/each}</select
			></label
		>
		<label class="field"
			>Status<select bind:value={f.status}
				>{#each JOB_STATUSES as s (s)}<option>{s}</option>{/each}</select
			></label
		>
	</div>
	<div class="fields-row">
		<label class="field"
			>Plate / revision<input
				bind:value={f.revision}
				maxlength="80"
				placeholder={existing ? '' : 'Automatic (v01, v02…)'}
			/></label
		>
		<label class="field"
			>Model<select bind:value={f.modelVersionId}
				><option value="">Not linked to a model</option>{#each modelOptions as o (o.id)}<option
						value={o.id}>{o.label}</option
					>{/each}</select
			></label
		>
	</div>
	<div class="fields-row">
		<label class="field"
			>Spool<select bind:value={f.spoolId} onchange={onSpool}
				><option value="">No spool / not tracked</option>{#each lab.ws.spools as s (s.id)}<option
						value={s.id}
						>{s.colorName || s.colorHex} · {s.material}{s.brand ? ` · ${s.brand}` : ''} ({weight(
							s.remainingGrams
						)} left)</option
					>{/each}</select
			></label
		>
	</div>
	<div class="fields-row">
		<label class="field"
			>Material<select bind:value={f.material}
				>{#each withCurrent(MATERIALS, f.material) as m (m)}<option>{m}</option>{/each}</select
			></label
		>
		<label class="field"
			>Filament (g)<input type="number" min="0" max="20000" step="0.1" bind:value={f.grams} /><small
				>Deducted from the spool when the print finishes.</small
			></label
		>
	</div>
	<div class="fields-row">
		<label class="field"
			>Estimated time (min)<input type="number" min="0" step="1" bind:value={f.minutes} /></label
		>
		<label class="field"
			>Actual time (min)<input type="number" min="0" step="1" bind:value={f.actualMinutes} /><small
				>Filled in automatically when a started job finishes.</small
			></label
		>
	</div>
	<div class="fields-row">
		<label class="field"
			>Layer height (mm)<select bind:value={f.layerHeight}
				><option value="">—</option
				>{#each withCurrent(LAYER_HEIGHTS, f.layerHeight) as v (v)}<option>{v}</option
					>{/each}</select
			></label
		>
		<label class="field"
			>Nozzle (mm)<select bind:value={f.nozzle}
				><option value="">—</option>{#each withCurrent(NOZZLES, f.nozzle) as v (v)}<option
						>{v}</option
					>{/each}</select
			></label
		>
	</div>
	<div class="fields-row">
		<label class="field"
			>Build plate<select bind:value={f.plate}
				><option value="">—</option>{#each withCurrent(PLATES, f.plate) as v (v)}<option>{v}</option
					>{/each}</select
			></label
		>
		<label class="field"
			>Supports<select bind:value={f.supports}
				>{#each SUPPORTS as v (v)}<option>{v}</option>{/each}</select
			></label
		>
	</div>
	<div class="fields-row">
		<label class="field"
			>Infill (%)<input type="number" min="0" max="100" step="1" bind:value={f.infill} /></label
		>
		<span></span>
	</div>
	<div class="fields-row">
		<label class="field">Started<input type="datetime-local" bind:value={f.startedAt} /></label>
		<label class="field">Finished<input type="datetime-local" bind:value={f.finishedAt} /></label>
	</div>
	<ExpandableText
		label="Result & notes"
		bind:value={f.notes}
		hint="What went well, what failed, what to change for the next plate."
		ai={{
			actions: ['checklist', 'tidy'],
			context: () => ({
				Project: lab.project(f.projectId)?.title ?? '',
				Material: f.material,
				Settings: `${f.layerHeight} mm layers, ${f.nozzle} nozzle, ${f.plate}, ${f.infill ?? '?'}% infill, supports ${f.supports}`,
				Status: f.status
			})
		}}
	/>
</EditorShell>
