<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { actions, projectHref } from '$lib/client/actions';
	import { meshFormat } from '$lib/client/models';
	import {
		parseModelLink,
		SITE_NAME,
		type ImportPreview,
		type ImportResult
	} from '$lib/shared/model-import';
	import Modal from '../Modal.svelte';
	import { bytes, imageSrc, importCall } from './api';
	import { importWindows } from './state.svelte';

	// "Import from a link": look up a model page, show its credits and licence, then bring it into a new
	// or existing project. Sites that do not give files to this app get a drop zone for the file the
	// user downloads in their browser.
	const app = useApp();
	const { lab, ui } = app;

	let url = $state(importWindows.link ?? '');
	let looking = $state(false);
	let error = $state('');
	let preview = $state<ImportPreview | null>(null);
	let chosen = $state<string[]>([]);
	let pictures = $state(true);
	const here = page.route.id?.startsWith('/projects/[id]') ? (page.params.id ?? '') : '';
	let target = $state(here && lab.project(here) ? here : 'new');
	let profileId = $state(
		ui.profile !== 'all' && lab.profile(ui.profile) ? ui.profile : (lab.ws.profiles[0]?.id ?? '')
	);
	let importing = $state(false);
	let result = $state<ImportResult | null>(null);
	let dropped = $state<string[]>([]);
	let dropping = $state(false);
	let over = $state(false);
	let fileInput = $state<HTMLInputElement>();
	let lookupButton = $state<HTMLButtonElement>();
	let controller: AbortController | null = null;

	const recognised = $derived(parseModelLink(url));
	const projects = $derived(
		[...lab.ws.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
	);
	const resultProject = $derived(result ? lab.project(result.projectId) : undefined);
	// The drop zone: for sites that do not give files to this app, or when a chosen file failed.
	const needsDrop = $derived(
		!!preview && !!result && (!preview.downloadable || result.modelIds.length < chosen.length)
	);

	async function lookUp(e?: SubmitEvent) {
		e?.preventDefault();
		error = '';
		if (!recognised) {
			error = 'Paste a model page link from Printables, Thingiverse or MakerWorld.';
			return;
		}
		controller?.abort();
		controller = new AbortController();
		looking = true;
		preview = null;
		try {
			const data = await importCall<{ preview: ImportPreview }>(
				lab,
				'POST',
				'/api/imports/url',
				{ url },
				controller.signal
			);
			preview = data.preview;
			chosen = data.preview.downloadable
				? data.preview.files.filter((f) => f.format).map((f) => f.id)
				: [];
		} catch (err) {
			if (!controller.signal.aborted) error = (err as Error).message;
		} finally {
			looking = false;
		}
	}

	async function confirm() {
		if (!preview) return;
		error = '';
		importing = true;
		try {
			const data = await importCall<{ result: ImportResult }>(
				lab,
				'POST',
				'/api/imports/url/confirm',
				{
					url: preview.url,
					projectId: target === 'new' ? null : target,
					profileId: target === 'new' ? profileId : null,
					files: chosen,
					pictures
				}
			);
			result = data.result;
			const n = data.result.modelIds.length;
			ui.toast(
				n
					? `Imported ${n} ${n === 1 ? 'file' : 'files'} with credits.`
					: 'Added the credits to the project.'
			);
		} catch (err) {
			error = (err as Error).message;
		} finally {
			importing = false;
		}
	}

	async function upload(files: FileList | File[] | null | undefined) {
		if (!result || !files?.length) return;
		dropping = true;
		try {
			for (const file of files) {
				if (!meshFormat(file.name)) {
					ui.toast(`“${file.name}” is not an STL, 3MF or OBJ file.`, 'error');
					continue;
				}
				if (await actions(app).uploadModel(result.projectId, file, false))
					dropped = [...dropped, file.name];
			}
		} finally {
			dropping = false;
		}
	}

	function close() {
		controller?.abort();
		importWindows.close();
	}

	async function openProject() {
		if (!result) return;
		const id = result.projectId;
		close();
		await goto(projectHref(id));
	}

	const toggle = (id: string) =>
		(chosen = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);

	// A link handed over by a paste or a drop is filled in, not looked up: nothing is asked of the site
	// until Look up is pressed (Enter does it, as the button has the focus).
	onMount(() => {
		if (recognised) requestAnimationFrame(() => lookupButton?.focus());
	});
</script>

<Modal id="import-link" onclose={close} busy={importing} class="import-dialog">
	<header class="dialog-top">
		<div>
			<div class="eyebrow">IMPORT</div>
			<h2 id="import-link-title">Import from a link</h2>
		</div>
		<button class="icon-button" aria-label="Close" disabled={importing} onclick={close}>×</button>
	</header>

	{#if !result}
		<form class="lookup" onsubmit={lookUp}>
			<label class="field grow"
				>Model page link<input
					bind:value={url}
					type="url"
					inputmode="url"
					autocomplete="off"
					placeholder="https://www.printables.com/model/…"
					maxlength="1000"
				/><small
					>Printables, Thingiverse or MakerWorld. The app asks the site only when you press Look up.</small
				></label
			>
			<button class="secondary" bind:this={lookupButton} disabled={looking || !url.trim()}
				>{looking ? 'Looking…' : 'Look up'}</button
			>
		</form>
	{/if}

	{#if error}<p class="error" role="alert">{error}</p>{/if}

	{#if preview && !result}
		<article class="preview" aria-label="Model details">
			{#if preview.images.length}
				<div class="pictures">
					{#each preview.images.slice(0, 4) as src, i (src)}
						<img src={imageSrc(src)} alt="Picture {i + 1} of {preview.title}" loading="lazy" />
					{/each}
				</div>
			{/if}
			<h3>{preview.title}</h3>
			<p class="byline">
				<!-- eslint-disable svelte/no-navigation-without-resolve -- links to the model's own site -->
				{#if preview.author}by {#if preview.authorUrl}<a
							href={preview.authorUrl}
							target="_blank"
							rel="noopener noreferrer">{preview.author}</a
						>{:else}{preview.author}{/if}&nbsp;·
				{/if}<a href={preview.url} target="_blank" rel="noopener noreferrer"
					>{SITE_NAME[preview.site]} ↗</a
				>
			</p>

			<section class="licence" class:caution={preview.terms.caution} aria-label="Licence">
				<p class="licence-name">
					<strong>{preview.terms.code}</strong>
					{#if preview.licence && preview.licence !== preview.terms.code}<small
							>{preview.licence}</small
						>{/if}
					{#if preview.licenceUrl}<a
							href={preview.licenceUrl}
							target="_blank"
							rel="noopener noreferrer">What it says ↗</a
						>{/if}
				</p>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
				<ul>
					{#each preview.terms.meaning as line (line)}<li>{line}</li>{/each}
				</ul>
				<small>The credit is added to the project description and kept with the project.</small>
			</section>

			{#if preview.description}<p class="description">{preview.description}</p>{/if}

			{#if preview.note}<p class="note">{preview.note}</p>{/if}

			{#if preview.files.length}
				<fieldset class="files" disabled={!preview.downloadable}>
					<legend>Files</legend>
					{#each preview.files as f (f.id)}
						<label class:off={!f.format}>
							<input
								type="checkbox"
								disabled={!f.format}
								checked={chosen.includes(f.id)}
								onchange={() => toggle(f.id)}
							/>
							<span class="file-name">{f.name}</span>
							<small>{f.format ? bytes(f.size) : 'This app cannot open this type'}</small>
						</label>
					{/each}
				</fieldset>
			{/if}

			<div class="fields-row">
				<label class="field"
					>Add to<select bind:value={target}>
						<option value="new">A new project</option>
						{#each projects as p (p.id)}<option value={p.id}>{p.title}</option>{/each}
					</select></label
				>
				{#if target === 'new'}
					<label class="field"
						>For<select bind:value={profileId}>
							{#each lab.ws.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
						</select></label
					>
				{/if}
			</div>
			{#if preview.images.length}
				<label class="check"
					><input type="checkbox" bind:checked={pictures} /> Save the pictures to the project as sketches</label
				>
			{/if}
		</article>
	{/if}

	{#if result}
		<div class="done" aria-live="polite">
			<p>
				{result.created ? 'Created' : 'Updated'}
				<strong>{resultProject?.title ?? 'the project'}</strong>
				with the credits{result.modelIds.length
					? `, ${result.modelIds.length} ${result.modelIds.length === 1 ? 'model' : 'models'}`
					: ''}{result.pictures
					? ` and ${result.pictures} ${result.pictures === 1 ? 'picture' : 'pictures'}`
					: ''}.
			</p>
			{#if result.skipped.length}
				<ul class="skipped">
					{#each result.skipped as s, i (i)}<li><b>{s.name}</b>: {s.reason}</li>{/each}
				</ul>
			{/if}
			{#if needsDrop}
				<div
					class="drop"
					class:over
					role="region"
					aria-label="Drop the downloaded file"
					ondragover={(e) => {
						if (e.dataTransfer?.types.includes('Files')) {
							e.preventDefault();
							over = true;
						}
					}}
					ondragleave={() => (over = false)}
					ondrop={(e) => {
						e.preventDefault();
						over = false;
						void upload(e.dataTransfer?.files);
					}}
				>
					<p>
						<strong>Downloaded it?</strong> Drop the STL, 3MF or OBJ file here to add it to this project.
					</p>
					<button class="mini" disabled={dropping} onclick={() => fileInput?.click()}
						>{dropping ? 'Importing…' : 'Choose file'}</button
					>
					<input
						bind:this={fileInput}
						type="file"
						accept=".stl,.3mf,.obj"
						multiple
						hidden
						onchange={(e) => void upload((e.currentTarget as HTMLInputElement).files)}
					/>
					{#if dropped.length}<small>Added: {dropped.join(', ')}</small>{/if}
				</div>
			{/if}
		</div>
	{/if}

	<div class="dialog-actions">
		<button class="ghost-button" disabled={importing} onclick={close}
			>{result ? 'Close' : 'Cancel'}</button
		>
		{#if result}
			<button class="primary" onclick={openProject}>Open project</button>
		{:else if preview}
			<button
				class="primary"
				disabled={importing || (target === 'new' && !profileId)}
				onclick={confirm}
				>{importing
					? 'Importing…'
					: chosen.length
						? `Import ${chosen.length} ${chosen.length === 1 ? 'file' : 'files'}`
						: 'Import credits'}</button
			>
		{/if}
	</div>
</Modal>

<style>
	:global(#import-link) {
		width: min(680px, calc(100% - 24px));
	}
	.lookup {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}
	.lookup .grow {
		flex: 1;
	}
	.lookup button {
		margin-top: 22px;
	}
	.error {
		color: var(--err-text);
		font-size: 13px;
		margin: 0 0 12px;
	}
	.preview h3 {
		margin: 4px 0 2px;
		font-size: 18px;
	}
	.byline {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
	}
	.pictures {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
		gap: 6px;
		margin-bottom: 10px;
	}
	.pictures img {
		width: 100%;
		aspect-ratio: 4 / 3;
		object-fit: cover;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: var(--panel);
	}
	.licence {
		border: 1px solid rgb(var(--c3) / 0.35);
		background: rgb(var(--c3) / 0.06);
		border-radius: var(--r-md);
		padding: 10px 12px;
		margin-bottom: 12px;
	}
	.licence.caution {
		border-color: rgb(var(--c4) / 0.45);
		background: rgb(var(--c4) / 0.08);
	}
	.licence-name {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
		margin: 0;
	}
	.licence-name strong {
		font-size: 15px;
	}
	.licence-name small,
	.licence > small {
		color: var(--muted);
	}
	.licence-name a {
		margin-left: auto;
		font-size: 12.5px;
	}
	.licence ul {
		margin: 6px 0;
		padding-left: 18px;
		font-size: 13.5px;
	}
	.description {
		font-size: 13px;
		color: var(--text-2);
		white-space: pre-line;
		max-height: 7.5em;
		overflow: auto;
		margin: 0 0 12px;
	}
	.note {
		font-size: 13px;
		padding: 8px 10px;
		border-radius: var(--r-md);
		background: rgb(var(--c1) / 0.07);
		border: 1px solid rgb(var(--c1) / 0.25);
		margin: 0 0 12px;
	}
	.files {
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		padding: 8px 12px;
		margin: 0 0 12px;
		display: grid;
		gap: 4px;
		max-height: 180px;
		overflow: auto;
	}
	.files legend {
		font-size: 12.5px;
		color: var(--muted);
		padding: 0 4px;
	}
	.files label {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
	}
	.files label.off {
		color: var(--dim);
	}
	.file-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.files small {
		color: var(--dim);
	}
	.check {
		display: flex;
		gap: 8px;
		align-items: center;
		font-size: 13px;
		color: var(--muted);
		margin-bottom: 12px;
	}
	.done p {
		margin: 0 0 10px;
	}
	.skipped {
		font-size: 13px;
		color: var(--muted);
		padding-left: 18px;
	}
	.drop {
		border: 1.5px dashed var(--line-strong);
		border-radius: var(--r-md);
		padding: 14px;
		display: grid;
		justify-items: start;
		gap: 8px;
		margin-bottom: 12px;
	}
	.drop.over {
		border-color: var(--cyan);
		background: rgb(var(--c1) / 0.06);
	}
	.drop p {
		margin: 0;
		font-size: 13.5px;
	}
	.drop small {
		color: var(--muted);
	}
	@media (max-width: 560px) {
		.lookup {
			flex-direction: column;
			align-items: stretch;
		}
		.lookup button {
			margin-top: 0;
		}
	}
</style>
