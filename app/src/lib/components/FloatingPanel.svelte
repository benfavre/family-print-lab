<script lang="ts">
	import { useApp, type Panel } from '$lib/client/app.svelte';
	import { setPanel } from '$lib/client/panel';
	import ProjectForm from './ProjectForm.svelte';
	import ProfileForm from './ProfileForm.svelte';
	import JobForm from './JobForm.svelte';
	import SpoolForm from './SpoolForm.svelte';
	import SendPanel from './SendPanel.svelte';

	let { panel }: { panel: Panel } = $props();
	const { ui } = useApp();
	// svelte-ignore state_referenced_locally
	const key = panel.key;
	const close = () => ui.closePanel(key);
	setPanel({ key, close, setTitle: (title) => ui.updatePanel(key, { title }) });

	const toggleMin = () => ui.updatePanel(key, { minimized: !panel.minimized, expanded: false });
	const toggleExpand = () => ui.updatePanel(key, { expanded: !panel.expanded, minimized: false });

	function keys(e: KeyboardEvent) {
		// Esc folds the panel away instead of discarding what was typed.
		if (e.key === 'Escape' && !e.defaultPrevented) {
			e.preventDefault();
			if (panel.expanded) toggleExpand();
			else toggleMin();
		}
	}
</script>

{#if panel.expanded}
	<!-- Clicking outside an expanded panel docks it again; nothing is lost. -->
	<div class="fp-backdrop" role="presentation" onclick={toggleExpand}></div>
{/if}
<div
	class="float-panel k-{panel.kind}"
	class:minimized={panel.minimized}
	class:expanded={panel.expanded}
	role="dialog"
	aria-modal="false"
	aria-label={panel.title || 'Panel'}
	data-panel={key}
	tabindex="-1"
	onkeydown={keys}
>
	<header class="fp-head">
		<button
			type="button"
			class="fp-title"
			title={panel.minimized ? 'Open' : 'Minimize'}
			aria-expanded={!panel.minimized}
			onclick={toggleMin}>{panel.title || '…'}</button
		>
		<button
			type="button"
			class="fp-btn"
			aria-label={panel.minimized ? 'Restore' : 'Minimize'}
			title={panel.minimized ? 'Restore' : 'Minimize (Esc)'}
			onclick={toggleMin}
			><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
				>{#if panel.minimized}<path d="M4 10l4-4 4 4" />{:else}<path d="M3.5 11.5h9" />{/if}</svg
			></button
		>
		<button
			type="button"
			class="fp-btn"
			aria-label={panel.expanded ? 'Dock' : 'Expand'}
			title={panel.expanded ? 'Back to the corner' : 'Expand'}
			onclick={toggleExpand}
			><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
				>{#if panel.expanded}<path
						d="M9.5 2.5v4h4M6.5 13.5v-4h-4M9.5 6.5l4-4M6.5 9.5l-4 4"
					/>{:else}<path
						d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5l4.5-4.5"
					/>{/if}</svg
			></button
		>
		<button type="button" class="fp-btn" aria-label="Close" title="Close" onclick={close}
			><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
				><path d="M4 4l8 8M12 4l-8 8" /></svg
			></button
		>
	</header>
	<!-- The content stays mounted while minimized, so nothing typed is lost. -->
	<div class="fp-body" hidden={panel.minimized}>
		{#if panel.kind === 'project'}<ProjectForm
				id={panel.id}
				preset={panel.preset}
				onclose={close}
			/>
		{:else if panel.kind === 'job'}<JobForm id={panel.id} preset={panel.preset} onclose={close} />
		{:else if panel.kind === 'spool'}<SpoolForm
				id={panel.id}
				preset={panel.preset}
				onclose={close}
			/>
		{:else if panel.kind === 'profile'}<ProfileForm id={panel.id} onclose={close} />
		{:else if panel.kind === 'send'}<SendPanel jobId={panel.id ?? ''} onclose={close} />
		{:else if panel.kind === 'sketch'}
			<!-- Heavy windows (3D, drawing) load only when opened. -->
			{#await import('./SketchEditor.svelte') then { default: SketchEditor }}<SketchEditor
					projectId={(panel.preset.projectId as string | null) ?? null}
					sketchId={panel.id}
					onsaved={panel.preset.onsaved as ((png: Blob) => void) | undefined}
					onclose={close}
				/>{/await}
		{:else}{#await import('./DesignDialog.svelte') then { default: DesignDialog }}<DesignDialog
					projectId={String(panel.preset.projectId)}
					taskIds={(panel.preset.taskIds as string[]) ?? []}
					startImage={panel.preset.image as
						{ mediaType: string; data: string; url: string } | undefined}
					startPrompt={panel.preset.prompt as string | undefined}
					onclose={close}
				/>{/await}{/if}
	</div>
</div>

<style>
	.float-panel {
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		width: min(460px, calc(100vw - 24px));
		max-height: min(78vh, 760px);
		border-radius: 14px 14px 0 0;
		border: 1px solid var(--line-strong);
		border-bottom: 0;
		background: var(--menu);
		box-shadow: 0 -8px 40px -12px rgb(var(--lo) / 0.6);
		animation: rise 0.18s ease-out;
		outline: none;
	}
	.float-panel.k-design,
	.float-panel.k-sketch {
		width: min(640px, calc(100vw - 24px));
	}
	.float-panel.minimized {
		width: 280px;
	}
	.float-panel.expanded {
		position: fixed;
		z-index: 61;
		left: 50%;
		top: 5vh;
		transform: translateX(-50%);
		width: min(1180px, calc(100vw - 32px));
		max-height: none;
		height: 90vh;
		border-radius: 14px;
		border-bottom: 1px solid var(--line-strong);
		box-shadow: 0 30px 90px rgb(var(--lo) / 0.55);
	}
	.fp-backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		pointer-events: auto;
		background: rgb(var(--base) / 0.45);
		backdrop-filter: blur(3px);
	}
	.fp-head {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 40px;
		padding: 0 6px 0 4px;
		border-bottom: 1px solid var(--line);
		border-radius: inherit;
		background: rgb(var(--hi) / 0.04);
		flex-shrink: 0;
	}
	.minimized .fp-head {
		border-bottom: 0;
	}
	.fp-title {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0 10px;
		border: 0;
		background: transparent;
		color: var(--text);
		font-size: 13px;
		font-weight: 600;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.fp-btn {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--muted);
	}
	.fp-btn svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.fp-btn:hover {
		color: var(--text);
		background: rgb(var(--hi) / 0.08);
	}
	.fp-body {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 16px 18px 0;
		scrollbar-width: thin;
		container-type: inline-size;
	}
	.fp-body[hidden] {
		display: none;
	}
	/* Forms keep their actions in reach at the bottom of the panel. */
	.fp-body :global(form.in-panel .dialog-actions) {
		position: sticky;
		bottom: 0;
		margin: 6px -18px 0;
		padding: 12px 18px 14px;
		background: var(--menu);
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(16px);
		}
	}
	.float-panel.expanded {
		animation: grow 0.18s ease-out;
	}
	@keyframes grow {
		from {
			opacity: 0;
			transform: translateX(-50%) scale(0.98);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.float-panel,
		.float-panel.expanded {
			animation: none;
		}
	}
	@media (max-width: 700px) {
		.float-panel,
		.float-panel.minimized,
		.float-panel.k-design {
			width: 100%;
		}
		.float-panel.expanded {
			top: 0;
			height: 100dvh;
			width: 100vw;
			border-radius: 0;
		}
	}
</style>
