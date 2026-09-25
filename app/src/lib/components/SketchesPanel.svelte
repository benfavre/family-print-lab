<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { stamp } from '$lib/client/format';
	import type { SketchSummary } from '$lib/shared/domain';

	let { projectId }: { projectId: string } = $props();
	const { lab, ui } = useApp();
	const sketches = $derived(lab.ws.sketches.filter((s) => s.projectId === projectId));
	const project = $derived(lab.project(projectId));
	const src = (s: SketchSummary) => `/api/sketches/${s.id}?v=${s.version}`;
	let starting = $state<string | null>(null);

	/** Opens the AI designer with this sketch attached and the idea as the starting prompt. */
	async function design(s: SketchSummary) {
		starting = s.id;
		try {
			const blob = await (await fetch(src(s))).blob();
			const url = await new Promise<string>((ok, fail) => {
				const reader = new FileReader();
				reader.onload = () => ok(String(reader.result));
				reader.onerror = fail;
				reader.readAsDataURL(blob);
			});
			const idea = [project?.title, project?.description].filter(Boolean).join(': ');
			ui.openDesignWith(projectId, {
				image: { mediaType: 'image/png', data: url.slice(url.indexOf(',') + 1), url },
				prompt: `Design this from my sketch${s.title ? ` (“${s.title}”)` : ''}. ${idea}`.trim()
			});
		} catch {
			ui.toast('Could not read the sketch.', 'error');
		} finally {
			starting = null;
		}
	}
	async function remove(s: SketchSummary) {
		if (
			await ui.ask(
				'Delete this sketch?',
				`${s.title || 'The sketch'} will be removed from the project.`
			)
		)
			await lab.call('DELETE', `/api/sketches/${s.id}`, undefined, 'Sketch deleted.');
	}
</script>

<section class="panel sketches-panel" aria-label="Sketches">
	<header class="panel-head">
		<h2>Sketches</h2>
		<button class="mini primary-mini" onclick={() => ui.openSketch({ projectId })}
			>✎ New sketch</button
		>
	</header>
	{#if sketches.length}
		<div class="sketch-grid">
			{#each sketches as s (s.id)}
				<article class="sketch-card">
					<button
						type="button"
						class="sketch-thumb"
						title="Open to draw on it"
						onclick={() => ui.openSketch({ sketchId: s.id })}
						><img src={src(s)} alt={s.title || 'Sketch'} loading="lazy" /></button
					>
					<div class="sk-caption">
						<span class="sk-title">{s.title || 'Sketch'}</span>
						<small>{stamp(s.updatedAt)}</small>
					</div>
					<div class="sk-actions">
						<button class="mini ai" disabled={starting === s.id} onclick={() => design(s)}
							>✦ Design from this</button
						>
						<button class="mini" onclick={() => ui.openSketch({ sketchId: s.id })}>Edit</button>
						<button
							class="mini icon"
							aria-label="Delete sketch"
							title="Delete"
							onclick={() => remove(s)}>×</button
						>
					</div>
				</article>
			{/each}
		</div>
	{:else}
		<p class="panel-empty">
			Draw what you have in mind: shapes, rough sizes, how it fits. A sketch can go straight to the
			AI designer.
		</p>
	{/if}
</section>

<style>
	.sketch-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 12px;
	}
	.sketch-card {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: rgb(var(--hi) / 0.02);
	}
	.sketch-thumb {
		display: block;
		padding: 0;
		border: 0;
		border-radius: 8px;
		overflow: hidden;
		background: #f7f4ec;
		aspect-ratio: 4 / 3;
		cursor: pointer;
		transition: transform 0.15s;
	}
	.sketch-thumb:hover {
		transform: translateY(-1px);
	}
	.sketch-thumb img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.sk-caption {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}
	.sk-title {
		flex: 1;
		min-width: 0;
		font-size: 13px;
		font-weight: 550;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sk-caption small {
		font-size: 11px;
		color: var(--dim);
	}
	.sk-actions {
		display: flex;
		gap: 5px;
		align-items: center;
	}
	.sk-actions .icon {
		margin-left: auto;
	}
</style>
