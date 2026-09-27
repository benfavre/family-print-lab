<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { actions, projectHref } from '$lib/client/actions';
	import Modal from '../Modal.svelte';
	import { bytes } from './api';
	import { importWindows } from './state.svelte';

	// "Add to…" for STL/3MF/OBJ files dropped anywhere: a new project named after the first file, or an
	// existing one. Files go through the normal model upload.
	const app = useApp();
	const { lab, ui } = app;
	const files = importWindows.files ?? [];

	const here = page.route.id?.startsWith('/projects/[id]') ? (page.params.id ?? '') : '';
	let target = $state(here && lab.project(here) ? here : 'new');
	let title = $state(
		(files[0]?.name ?? '').replace(/\.[^.]+$/, '').slice(0, 80) || 'Imported model'
	);
	let profileId = $state(
		ui.profile !== 'all' && lab.profile(ui.profile) ? ui.profile : (lab.ws.profiles[0]?.id ?? '')
	);
	let busy = $state(false);
	const projects = $derived(
		[...lab.ws.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
	);

	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			let projectId = target;
			if (target === 'new') {
				const res = await lab.call<{ id: string }>('POST', '/api/projects', {
					profileId,
					title: title.trim() || 'Imported model'
				});
				if (!res) return;
				projectId = res.id;
				// A retry after a failed upload adds to this project instead of making another.
				target = projectId;
			}
			const act = actions(app);
			let added = 0;
			for (const file of files) if (await act.uploadModel(projectId, file, false)) added++;
			if (!added) return;
			importWindows.close();
			await goto(projectHref(projectId));
		} finally {
			busy = false;
		}
	}
</script>

<Modal id="import-files" onclose={() => importWindows.close()} {busy}>
	<form onsubmit={add}>
		<header class="dialog-top">
			<div>
				<div class="eyebrow">ADD MODELS</div>
				<h2 id="import-files-title">
					Add {files.length === 1 ? `“${files[0].name}”` : `${files.length} files`} to…
				</h2>
			</div>
		</header>
		{#if files.length > 1}
			<ul class="dropped">
				{#each files as f, i (i)}<li>{f.name} <small>{bytes(f.size)}</small></li>{/each}
			</ul>
		{/if}
		<label class="field"
			>Project<select bind:value={target}>
				<option value="new">A new project</option>
				{#each projects as p (p.id)}<option value={p.id}>{p.title}</option>{/each}
			</select></label
		>
		{#if target === 'new'}
			<div class="fields-row">
				<label class="field">Name<input bind:value={title} maxlength="80" required /></label>
				<label class="field"
					>For<select bind:value={profileId} required>
						{#each lab.ws.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
					</select></label
				>
			</div>
		{/if}
		<div class="dialog-actions">
			<button
				type="button"
				class="ghost-button"
				disabled={busy}
				onclick={() => importWindows.close()}>Cancel</button
			>
			<button class="primary" disabled={busy || (target === 'new' && !profileId)}
				>{busy ? 'Importing…' : 'Add'}</button
			>
		</div>
	</form>
</Modal>

<style>
	:global(#import-files) {
		width: min(480px, calc(100% - 24px));
	}
	.dropped {
		margin: 0 0 12px;
		padding-left: 18px;
		font-size: 13px;
	}
	.dropped small {
		color: var(--dim);
	}
</style>
