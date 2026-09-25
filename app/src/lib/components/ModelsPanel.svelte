<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { actions } from '$lib/client/actions';
	import { fileUrl, makeThumbnail, MESH_ACCEPT, modelHref } from '$lib/client/models';
	import { stamp } from '$lib/client/format';
	import { INTEGRATION_GLYPH } from '$lib/client/integrations';
	import { AI_PROVIDER_NAME } from '$lib/shared/integrations';

	let { projectId }: { projectId: string } = $props();
	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);
	const models = $derived(
		lab.ws.models
			.filter((m) => m.projectId === projectId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
	);
	// AI designs for this project that are running, or finished and not used yet.
	const pending = $derived(
		lab
			.tasksForProject(projectId)
			.filter(
				(t) =>
					t.kind === 'ai-design' && (t.status === 'running' || (t.status === 'done' && !t.usedBy))
			)
	);
	let now = $state(Date.now());
	$effect(() => {
		if (!pending.some((t) => t.status === 'running')) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	// Fill in missing thumbnails one at a time in the background.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping only, must not re-run the effect
	const tried = new Set<string>();
	let thumbnailing = false;
	$effect(() => {
		const missing = models
			.map(
				(m) =>
					m.versions.find((v) => v.id === m.currentVersionId && !v.hasThumbnail) && {
						m,
						v: m.versions.find((v) => v.id === m.currentVersionId)!
					}
			)
			.filter((x): x is NonNullable<typeof x> => !!x && !tried.has(x.v.id));
		if (!missing.length || thumbnailing) return;
		thumbnailing = true;
		void (async () => {
			let made = false;
			for (const { m, v } of missing) {
				tried.add(v.id);
				made = (await makeThumbnail(m.id, v.id)) || made;
			}
			thumbnailing = false;
			if (made) await lab.refresh();
		})();
	});
	let dragging = $state(false);
	let uploading = $state(false);
	let fileInput: HTMLInputElement;

	async function upload(files: FileList | File[] | null | undefined) {
		const list = [...(files ?? [])];
		if (!list.length) return;
		uploading = true;
		// Several files: import them all and stay here; one file: open it.
		for (const f of list) await act.uploadModel(projectId, f, list.length === 1);
		uploading = false;
	}
	const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
</script>

<section
	class="panel models-panel"
	class:dragging
	aria-label="Models"
	ondragover={(e) => {
		if (e.dataTransfer?.types.includes('Files')) {
			e.preventDefault();
			dragging = true;
		}
	}}
	ondragleave={(e) => {
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dragging = false;
	}}
	ondrop={(e) => {
		e.preventDefault();
		dragging = false;
		void upload(e.dataTransfer?.files);
	}}
>
	<header class="panel-head">
		<h2>Models</h2>
		<span class="head-actions">
			<button class="mini ai" onclick={() => ui.openDesign(projectId)}>✦ Design with AI</button>
			<button class="mini" disabled={uploading} onclick={() => fileInput.click()}
				>{uploading ? 'Importing…' : '⇪ Import STL/3MF'}</button
			>
			<button class="mini primary-mini" onclick={() => act.newModel(projectId)}
				>＋ Parametric</button
			>
		</span>
		<input
			bind:this={fileInput}
			type="file"
			accept={MESH_ACCEPT}
			multiple
			hidden
			onchange={(e) => upload(e.currentTarget.files)}
		/>
	</header>
	{#if models.length || pending.length}
		<div class="model-grid">
			{#each pending as t (t.id)}
				<button
					type="button"
					class="model-card task-card"
					class:running={t.status === 'running'}
					onclick={() => ui.openDesign(projectId, [t.id])}
				>
					<span class="model-thumb">
						{#if t.status === 'running'}<span class="spinner" aria-hidden="true"></span>{:else}<span
								class="ready-mark"
								aria-hidden="true">✦</span
							>{/if}
						<span class="model-kind ai"
							>{INTEGRATION_GLYPH[t.provider ?? 'claude-code']}
							{AI_PROVIDER_NAME[t.provider ?? 'claude-code']}</span
						>
					</span>
					<span class="model-info">
						<strong>{t.suggestion?.name ?? t.title}</strong>
						<small
							>{t.status === 'running'
								? `${t.stage} ${Math.max(0, Math.round((now - Date.parse(t.startedAt)) / 1000))} s`
								: 'Ready to review'}</small
						>
					</span>
				</button>
			{/each}
			{#each models as m (m.id)}
				{@const v = m.versions.find((x) => x.id === m.currentVersionId)}
				<a class="model-card" href={modelHref(projectId, m.id)} data-model={m.id}>
					<span class="model-thumb">
						{#if v?.hasThumbnail}<img
								src={fileUrl(m.id, v.id, 'thumbnail.png')}
								alt=""
								loading="lazy"
							/>{:else}<span aria-hidden="true">⬡</span>{/if}
						<span class="model-kind" class:mesh={m.kind === 'mesh'}
							>{m.kind === 'mesh' ? 'Mesh' : 'Parametric'}</span
						>
					</span>
					<span class="model-info">
						<strong>{m.name}</strong>
						<small
							>{#if v}{fmt(v.sizeX)}×{fmt(v.sizeY)}×{fmt(v.sizeZ)} mm ·
							{/if}v{v?.number ?? 0} · {stamp(m.updatedAt)}</small
						>
					</span>
				</a>
			{/each}
		</div>
	{:else}
		<div class="models-empty">
			<p>
				<strong>No models yet.</strong> Start a parametric design with sliders, describe the part to the
				AI, or drop an STL, 3MF or OBJ file here.
			</p>
		</div>
	{/if}
	{#if dragging}<div class="drop-hint">Drop to import</div>{/if}
</section>

<style>
	.models-panel {
		position: relative;
	}
	.models-panel.dragging {
		border-color: rgb(var(--c1) / 0.7);
	}
	.drop-hint {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		border-radius: inherit;
		background: rgb(var(--base) / 0.75);
		color: var(--cyan);
		font-weight: 550;
		pointer-events: none;
	}
	.model-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
		gap: 10px;
	}
	.model-card {
		display: flex;
		flex-direction: column;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: rgb(var(--hi) / 0.02);
		text-decoration: none;
		color: inherit;
		overflow: hidden;
		transition:
			border-color 0.15s,
			transform 0.15s;
	}
	.model-card:hover {
		border-color: rgb(var(--c1) / 0.5);
		transform: translateY(-1px);
	}
	.model-thumb {
		position: relative;
		aspect-ratio: 4 / 3;
		display: grid;
		place-items: center;
		background:
			radial-gradient(90% 80% at 50% 30%, rgb(var(--c1) / 0.08), transparent 70%),
			var(--panel-strong);
		color: var(--dim);
		font-size: 28px;
	}
	.model-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.model-kind {
		position: absolute;
		top: 6px;
		left: 6px;
		font: 500 9.5px var(--mono);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 2px 6px;
		border-radius: 999px;
		background: rgb(var(--base) / 0.75);
		color: var(--cyan);
	}
	.model-kind.mesh {
		color: var(--violet);
	}
	.model-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 10px 9px;
		min-width: 0;
	}
	.model-info strong {
		font-size: 13px;
		font-weight: 550;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.model-info small {
		font-size: 11.5px;
		color: var(--dim);
		font-variant-numeric: tabular-nums;
	}
	.task-card {
		padding: 0;
		font: inherit;
		text-align: left;
		cursor: pointer;
		border-style: dashed;
		border-color: rgb(var(--c2) / 0.45);
	}
	.task-card .model-thumb {
		background:
			radial-gradient(90% 80% at 50% 30%, rgb(var(--c2) / 0.12), transparent 70%),
			var(--panel-strong);
	}
	.task-card.running .model-thumb {
		animation: breathe 2.4s ease-in-out infinite;
	}
	.model-kind.ai {
		color: var(--c2-text);
	}
	.ready-mark {
		font-size: 26px;
		color: var(--violet);
	}
	.spinner {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid rgb(var(--c2) / 0.25);
		border-top-color: var(--violet);
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
	@keyframes breathe {
		50% {
			filter: brightness(1.25);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.task-card.running .model-thumb,
		.spinner {
			animation: none;
		}
	}
	.models-empty p {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
</style>
