<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { dueLabel, intervalLabel, type MaintenanceTaskView } from '$lib/shared/maintenance';
	import { stamp } from '$lib/client/format';
	import type { MaintenanceData } from './overview.svelte';

	// Every task of one printer with how soon it is due; mark done, edit, remove, or add your own.
	let { data }: { data: MaintenanceData } = $props();
	const { ui } = useApp();
	const tasks = $derived(data.overview?.tasks ?? []);

	interface Draft {
		label: string;
		/** Number inputs bind numbers; empty is null or undefined. */
		days: number | null | undefined;
		hours: number | null | undefined;
		notes: string;
	}
	const blank = (): Draft => ({ label: '', days: null, hours: null, notes: '' });
	let editing = $state<string | null>(null);
	let draft = $state<Draft>(blank());
	let adding = $state(false);
	let fresh = $state<Draft>(blank());

	const num = (v: number | null | undefined) =>
		typeof v === 'number' && Number.isFinite(v) ? v : null;
	const body = (d: Draft) => ({
		label: d.label,
		intervalDays: num(d.days),
		intervalHours: num(d.hours),
		notes: d.notes
	});

	function edit(t: MaintenanceTaskView) {
		editing = t.id;
		draft = {
			label: t.label,
			days: t.intervalDays,
			hours: t.intervalHours,
			notes: t.notes
		};
	}
	async function save(e: SubmitEvent, t: MaintenanceTaskView) {
		e.preventDefault();
		if (await data.write('PATCH', `/tasks/${t.id}`, body(draft), 'Task saved.')) editing = null;
	}
	async function add(e: SubmitEvent) {
		e.preventDefault();
		if (await data.write('POST', '/tasks', body(fresh), 'Task added.')) {
			fresh = blank();
			adding = false;
		}
	}
	async function remove(t: MaintenanceTaskView) {
		if (
			await ui.ask(
				`Remove “${t.label}”?`,
				'It stops being tracked. What you already logged for it stays in the log.',
				'Remove'
			)
		)
			await data.write('DELETE', `/tasks/${t.id}`, undefined, 'Task removed.');
	}
</script>

{#snippet fields(d: Draft)}
	<label class="field">Task<input bind:value={d.label} required maxlength="120" /></label>
	<div class="fields-row">
		<label class="field"
			>Every … days<input
				type="number"
				min="1"
				max="3650"
				step="1"
				bind:value={d.days}
				placeholder="No limit"
			/></label
		>
		<label class="field"
			>Every … print hours<input
				type="number"
				min="0.1"
				max="100000"
				step="any"
				bind:value={d.hours}
				placeholder="No limit"
			/></label
		>
	</div>
	<label class="field"
		>Notes<textarea bind:value={d.notes} rows="2" maxlength="2000"></textarea></label
	>
{/snippet}

<section class="panel">
	<header class="panel-head">
		<h2>Tasks</h2>
		<button class="mini" onclick={() => (adding = !adding)}
			>{adding ? 'Close' : '＋ Add a task'}</button
		>
	</header>
	{#if adding}
		<form class="task-form" onsubmit={add}>
			{@render fields(fresh)}
			<p class="hint">Leave both empty for a task you do when needed.</p>
			<button class="mini primary-mini" type="submit">Add task</button>
		</form>
	{/if}
	{#if !tasks.length}
		<p class="panel-empty">No tasks yet.</p>
	{:else}
		<ul class="tasks">
			{#each tasks as t (t.id)}
				<li data-task={t.kind} class="s-{t.due.state}">
					{#if editing === t.id}
						<form class="task-form" onsubmit={(e) => save(e, t)}>
							{@render fields(draft)}
							<div class="row">
								<button class="mini primary-mini" type="submit">Save</button>
								<button class="mini" type="button" onclick={() => (editing = null)}>Cancel</button>
							</div>
						</form>
					{:else}
						<div class="top">
							<b>{t.label}</b>
							<span class="state">{dueLabel(t.due)}</span>
						</div>
						{#if t.due.progress !== null}
							<span
								class="bar"
								style:--p={Math.min(1, t.due.progress)}
								role="progressbar"
								aria-label="{t.label}: how much of the interval is used"
								aria-valuemin="0"
								aria-valuemax="100"
								aria-valuenow={Math.round(Math.min(1, t.due.progress) * 100)}
							></span>
						{/if}
						<div class="meta">
							{intervalLabel(t)} · last done {t.lastDoneAt ? stamp(t.lastDoneAt) : 'not yet'}
							{#if t.source}
								<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the Bambu Lab wiki, not an app route -->
								· <a href={t.source} target="_blank" rel="noopener noreferrer">Bambu Lab wiki</a>
							{/if}
						</div>
						{#if t.notes}<p class="notes">{t.notes}</p>{/if}
						<div class="row">
							<button class="mini primary-mini" onclick={() => data.done(t.id)}>✓ Done</button>
							<button class="mini" onclick={() => edit(t)}>Edit</button>
							<button class="mini danger-mini" onclick={() => remove(t)}>Remove</button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.tasks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.tasks li {
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		display: grid;
		gap: 6px;
		font-size: 13px;
	}
	.tasks li.s-due {
		border-color: color-mix(in srgb, var(--amber) 60%, var(--line));
	}
	.top {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
	}
	.state {
		color: var(--muted);
	}
	.s-due .state {
		color: var(--amber);
		font-weight: 550;
	}
	.bar {
		display: block;
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			var(--cyan) calc(var(--p) * 100%),
			rgb(var(--hi) / 0.08) calc(var(--p) * 100%)
		);
	}
	.s-soon .bar,
	.s-due .bar {
		background: linear-gradient(
			to right,
			var(--amber) calc(var(--p) * 100%),
			rgb(var(--hi) / 0.08) calc(var(--p) * 100%)
		);
	}
	.meta,
	.hint {
		color: var(--dim);
		font-size: 12px;
	}
	.hint {
		margin: 0 0 10px;
	}
	.notes {
		margin: 0;
		color: var(--text-2);
		font-size: 12.5px;
		line-height: 1.5;
	}
	.row {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.task-form {
		margin-bottom: 10px;
	}
</style>
