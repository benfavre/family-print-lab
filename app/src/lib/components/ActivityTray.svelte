<script lang="ts">
	import { goto } from '$app/navigation';
	import { useApp } from '$lib/client/app.svelte';
	import { projectHref } from '$lib/client/actions';
	import { modelHref } from '$lib/client/models';
	import { INTEGRATION_GLYPH } from '$lib/client/integrations';
	import { AI_PROVIDER_NAME } from '$lib/shared/integrations';
	import type { TaskInfo, TaskKind } from '$lib/shared/tasks';

	const { lab, ui } = useApp();
	let open = $state(false);
	let root = $state<HTMLDivElement>();
	let now = $state(Date.now());

	const running = $derived(lab.tasks.filter((t) => t.status === 'running'));
	const waiting = $derived(
		lab.tasks.filter((t) => t.status === 'done' && t.suggestion && !t.usedBy)
	);
	const finished = $derived(lab.tasks.filter((t) => t.status !== 'running'));

	$effect(() => {
		if (!open && !running.length) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const KIND: Record<TaskKind, [string, string]> = {
		'ai-design': ['✦', 'AI design'],
		'ai-edit': ['✦', 'AI change'],
		'blender-repair': ['◉', 'Blender repair'],
		'blender-decimate': ['◉', 'Blender simplify'],
		'blender-session': ['◉', 'Blender window']
	};
	const elapsed = (t: TaskInfo) => {
		const end = t.finishedAt ? Date.parse(t.finishedAt) : now;
		const s = Math.max(0, Math.round((end - Date.parse(t.startedAt)) / 1000));
		return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
	};
	const glyph = (t: TaskInfo) => (t.provider ? INTEGRATION_GLYPH[t.provider] : KIND[t.kind][0]);
	const who = (t: TaskInfo) => (t.provider ? AI_PROVIDER_NAME[t.provider] : KIND[t.kind][1]);

	/** Designs asked of both AIs at once reopen together. */
	function review(t: TaskInfo) {
		const siblings = lab.tasks.filter(
			(o) =>
				o.kind === 'ai-design' &&
				o.projectId === t.projectId &&
				o.title === t.title &&
				Math.abs(Date.parse(o.startedAt) - Date.parse(t.startedAt)) < 5000
		);
		open = false;
		ui.openDesign(
			t.projectId!,
			siblings.map((o) => o.id)
		);
	}
	async function keepEdit(t: TaskInfo) {
		if (!t.modelId || !t.suggestion) return;
		const res = await lab.call(
			'POST',
			`/api/models/${t.modelId}/versions`,
			{
				source: t.suggestion.source,
				params: {},
				note: `AI: ${t.suggestion.summary}`.slice(0, 200),
				origin: 'ai',
				taskId: t.id
			},
			'Saved as a new version.'
		);
		if (res && t.projectId) await goto(modelHref(t.projectId, t.modelId));
	}
	async function stop(t: TaskInfo) {
		if (
			t.kind === 'blender-session' &&
			!(await ui.ask(
				'Close Blender?',
				'Anything not saved in Blender will be lost.',
				'Close Blender'
			))
		)
			return;
		await lab.taskAction(t.id, 'cancel');
	}
	function clearFinished() {
		for (const t of finished) void lab.taskAction(t.id, 'dismiss');
	}
	function outside(e: MouseEvent) {
		if (
			open &&
			root &&
			!root.contains(e.target as Node) &&
			!(e.target as HTMLElement).closest('dialog')
		)
			open = false;
	}
</script>

<svelte:window onclick={outside} onkeydown={(e) => e.key === 'Escape' && open && (open = false)} />

<div class="activity" bind:this={root}>
	<button
		type="button"
		class="activity-button"
		class:busy={running.length}
		class:ready={waiting.length}
		aria-expanded={open}
		aria-haspopup="true"
		title={running.length
			? `${running.length} running`
			: waiting.length
				? `${waiting.length} ready to review`
				: 'Activity'}
		onclick={() => (open = !open)}
	>
		<span class="act-ring" aria-hidden="true"></span>
		<span class="act-label">Activity</span>
		{#if running.length}<b>{running.length}</b>{:else if waiting.length}<b class="ready-count"
				>{waiting.length}</b
			>{/if}
	</button>

	{#if open}
		<div class="tray" role="region" aria-label="Activity">
			<header>
				<strong>Activity</strong>
				<span class="sub">{running.length} running · {waiting.length} to review</span>
				{#if finished.length}<button type="button" class="mini" onclick={clearFinished}
						>Clear finished</button
					>{/if}
			</header>
			{#if !lab.tasks.length}
				<p class="empty">
					Nothing running. AI designs and changes and Blender jobs show up here while they work, in
					every open tab.
				</p>
			{:else}
				<ol>
					{#each lab.tasks as t (t.id)}
						{@const project = lab.project(t.projectId)}
						<li class="task s-{t.status}" data-task={t.id}>
							<span class="t-glyph" aria-hidden="true">{glyph(t)}</span>
							<div class="t-body">
								<div class="t-top">
									<strong>{t.suggestion?.name ?? t.title}</strong>
									<span class="t-time">{elapsed(t)}</span>
								</div>
								<div class="t-meta">
									{who(t)}{#if project}
										·
										<a
											href={t.modelId ? modelHref(project.id, t.modelId) : projectHref(project.id)}
											onclick={() => (open = false)}>{project.title}</a
										>{/if}
								</div>
								<div class="t-stage">
									{#if t.status === 'running'}<span class="spinner" aria-hidden="true"
										></span>{t.stage}
									{:else if t.status === 'failed'}<span class="bad">✕ {t.error}</span>
									{:else if t.status === 'cancelled'}Stopped
									{:else if t.usedBy}<span class="ok">✓ Used</span>
									{:else if t.suggestion}<span class="ok"
											>✓ Ready{t.suggestion.render.ok ? '' : ' (does not render yet)'}</span
										>
									{:else}<span class="ok">✓ {t.stage}</span>{/if}
								</div>
								<div class="t-actions">
									{#if t.status === 'running'}
										<button type="button" class="mini" onclick={() => stop(t)}
											>{t.kind === 'blender-session' ? 'Close Blender' : 'Stop'}</button
										>
									{:else if t.kind === 'ai-design' && t.suggestion && !t.usedBy}
										<button type="button" class="mini primary-mini" onclick={() => review(t)}
											>Review</button
										>
									{:else if t.kind === 'ai-edit' && t.suggestion && !t.usedBy}
										<button type="button" class="mini primary-mini" onclick={() => keepEdit(t)}
											>Save as new version</button
										>
									{/if}
									{#if t.modelId && project && t.status !== 'running'}
										<a
											class="mini"
											href={modelHref(project.id, t.modelId)}
											onclick={() => (open = false)}>Open model</a
										>
									{/if}
									{#if t.status !== 'running'}
										<button
											type="button"
											class="mini icon"
											aria-label="Dismiss"
											onclick={() => lab.taskAction(t.id, 'dismiss')}>×</button
										>
									{/if}
								</div>
							</div>
						</li>
					{/each}
				</ol>
			{/if}
		</div>
	{/if}
</div>

<style>
	.activity {
		position: relative;
	}
	.activity-button {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		height: 28px;
		padding: 0 11px;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--muted);
		font-size: 12.5px;
	}
	.activity-button:hover,
	.activity-button[aria-expanded='true'] {
		color: var(--text);
		background: rgb(var(--hi) / 0.07);
	}
	.act-ring {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 2px solid var(--dim);
	}
	.busy .act-ring {
		border-color: rgb(var(--c2) / 0.3);
		border-top-color: var(--violet);
		animation: spin 0.9s linear infinite;
	}
	.ready .act-ring {
		border-color: var(--lime);
	}
	.activity-button b {
		font: 600 11px var(--mono);
		padding: 0 6px;
		border-radius: 999px;
		background: rgb(var(--c2) / 0.25);
		color: var(--text);
	}
	.activity-button b.ready-count {
		background: rgb(var(--c3) / 0.25);
	}
	.tray {
		position: absolute;
		right: 0;
		top: calc(100% + 8px);
		z-index: 50;
		width: min(420px, calc(100vw - 24px));
		max-height: min(560px, 75vh);
		overflow-y: auto;
		border-radius: var(--r-lg);
		border: 1px solid var(--line-strong);
		background: var(--menu);
		box-shadow: 0 24px 60px rgb(var(--lo) / 0.45);
		padding: 12px;
		scrollbar-width: thin;
	}
	.tray header {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
	}
	.tray header strong {
		font-size: 14px;
	}
	.sub {
		flex: 1;
		font-size: 12px;
		color: var(--dim);
	}
	.empty {
		margin: 6px 0;
		font-size: 13px;
		color: var(--muted);
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.task {
		display: flex;
		gap: 10px;
		padding: 9px 10px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: rgb(var(--hi) / 0.02);
	}
	.task.s-running {
		border-color: rgb(var(--c2) / 0.4);
	}
	.t-glyph {
		width: 22px;
		flex-shrink: 0;
		text-align: center;
		color: var(--violet);
		font-size: 14px;
		padding-top: 1px;
	}
	.t-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.t-top {
		display: flex;
		gap: 8px;
		align-items: baseline;
	}
	.t-top strong {
		flex: 1;
		min-width: 0;
		font-size: 13px;
		font-weight: 550;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.t-time {
		font-size: 11.5px;
		color: var(--dim);
		font-variant-numeric: tabular-nums;
	}
	.t-meta {
		font-size: 12px;
		color: var(--dim);
	}
	.t-meta a {
		color: var(--muted);
	}
	.t-stage {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--c2-text);
	}
	.ok {
		color: var(--lime);
	}
	.bad {
		color: var(--err-text);
	}
	.t-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 3px;
	}
	.t-actions:empty {
		display: none;
	}
	.t-actions a.mini {
		text-decoration: none;
	}
	.t-actions .icon {
		margin-left: auto;
	}
	.spinner {
		width: 10px;
		height: 10px;
		flex-shrink: 0;
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
	@media (max-width: 1380px) {
		.act-label {
			display: none;
		}
	}
</style>
