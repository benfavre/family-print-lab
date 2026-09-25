<script lang="ts">
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		CATEGORIES,
		PROJECT_STATUSES,
		type Category,
		type ProjectStatus
	} from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import { actions, projectHref } from '$lib/client/actions';
	import EditorShell from './EditorShell.svelte';
	import ExpandableText from './ExpandableText.svelte';

	let {
		id,
		preset,
		onclose
	}: { id: string | null; preset: Record<string, unknown>; onclose: () => void } = $props();
	const app = useApp();
	const { lab, ui } = app;
	// The editor is recreated for each record ({#key}), so reading props once is intended.
	const existing = untrack(() => (id ? lab.project(id) : undefined));
	const initial = untrack(() => preset);
	const defaultOwner = (ui.profile !== 'all' ? ui.profile : lab.ws.profiles[0]?.id) ?? '';
	let f = $state({
		title: existing?.title ?? String(initial.title ?? ''),
		profileId: existing?.profileId ?? String(initial.profileId ?? defaultOwner),
		status: (existing?.status ?? 'Idea') as ProjectStatus,
		category: (existing?.category ?? (initial.category as Category) ?? 'Home') as Category,
		material: existing?.material ?? '',
		description: existing?.description ?? '',
		url: existing?.url ?? '',
		files: existing?.files ?? '',
		notes: existing?.notes ?? ''
	});
	let busy = $state(false);
	/** Sketches drawn before the idea exists; uploaded right after it is created. */
	let pending = $state<{ blob: Blob; url: string }[]>([]);
	function sketch() {
		if (existing) ui.openSketch({ projectId: existing.id });
		else
			ui.openSketch({
				onsaved: (blob) => (pending = [...pending, { blob, url: URL.createObjectURL(blob) }])
			});
	}
	/** What the AI gets to know about this idea when helping with its text fields. */
	const context = () => {
		const who = lab.profile(f.profileId);
		return {
			Project: f.title,
			Category: f.category,
			For: who
				? `${who.name}${who.age !== null ? `, age ${who.age}` : ''}${who.interests ? ` (likes: ${who.interests})` : ''}`
				: '',
			Material: f.material,
			Idea: f.description
		};
	};

	async function save() {
		busy = true;
		const res = existing
			? await lab.call(
					'PATCH',
					`/api/projects/${existing.id}`,
					{ ...f, version: existing.version },
					'Saved.'
				)
			: await lab.call<{ id: string }>('POST', '/api/projects', f, `Added “${f.title}”.`);
		if (res && !existing && 'id' in res)
			for (const p of pending)
				await fetch(`/api/projects/${res.id}/sketches`, {
					method: 'POST',
					headers: { 'content-type': 'image/png' },
					body: p.blob
				});
		busy = false;
		if (!res) return;
		onclose();
		if (!existing && 'id' in res) await goto(projectHref(res.id as string));
	}
	async function remove() {
		if (existing && (await actions(app).deleteProject(existing))) {
			onclose();
			await goto(resolve('/'));
		}
	}
</script>

<EditorShell
	subject={f.title}
	id="project-editor"
	eyebrow="MAKE IT YOURS"
	title={existing ? 'Edit project' : 'A new idea'}
	{busy}
	error=""
	saveLabel={existing ? 'Save changes' : 'Add idea'}
	onsubmit={save}
	{onclose}
	ondelete={existing ? remove : undefined}
>
	<label class="field">Project name<input bind:value={f.title} required maxlength="80" /></label>
	<div class="fields-row">
		<label class="field"
			>For<select bind:value={f.profileId}
				>{#each lab.ws.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select
			></label
		>
		<label class="field"
			>Progress<select bind:value={f.status}
				>{#each PROJECT_STATUSES as s (s)}<option>{s}</option>{/each}</select
			></label
		>
	</div>
	<div class="fields-row">
		<label class="field"
			>Category<select bind:value={f.category}
				>{#each CATEGORIES as c (c)}<option>{c}</option>{/each}</select
			></label
		>
		<label class="field">Material / color<input bind:value={f.material} maxlength="1000" /></label>
	</div>
	<ExpandableText
		label="The idea"
		bind:value={f.description}
		ai={{ actions: ['flesh', 'clarify', 'questions'], context }}
		placeholder="A few words are enough; ✦ can flesh it out."
	/>
	<div class="sketch-row">
		<button type="button" class="mini" onclick={sketch}
			>✎ {existing ? 'Add a sketch' : 'Sketch it'}</button
		>
		{#each pending as p, i (p.url)}
			<span class="pending"
				><img src={p.url} alt="Sketch {i + 1}" /><button
					type="button"
					class="mini icon"
					aria-label="Remove sketch {i + 1}"
					onclick={() => (pending = pending.filter((x) => x !== p))}>×</button
				></span
			>
		{/each}
		{#if !pending.length}<small
				>Draw it; the sketch is saved with the idea and can go to the AI designer.</small
			>{/if}
	</div>
	<label class="field"
		>Model or reference link<input type="url" bind:value={f.url} maxlength="1000" /><small
			>Check dimensions and license before marking it Planned.</small
		></label
	>
	<ExpandableText
		label="Design & slicer file references"
		bind:value={f.files}
		ai={{ actions: ['files'], context }}
		hint="One per line, e.g. projects/cable-guide/cad/v01.step. Files stay in your project folder."
	/>
	<ExpandableText
		label="Measurements, print settings & results"
		bind:value={f.notes}
		ai={{ actions: ['measure', 'tidy'], context }}
	/>
</EditorShell>

<style>
	.sketch-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin: -4px 0 12px;
	}
	.sketch-row small {
		font-size: 11.5px;
		color: var(--dim);
	}
	.pending {
		position: relative;
		width: 64px;
		height: 48px;
		border-radius: 6px;
		overflow: hidden;
		background: #f7f4ec;
		border: 1px solid var(--line);
	}
	.pending img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.pending button {
		position: absolute;
		top: 0;
		right: 0;
		padding: 0 5px;
		background: rgb(var(--base) / 0.7);
	}
</style>
