<script lang="ts">
	import { FINISHED_JOB, type Job, type JobStatus } from '$lib/shared/domain';
	import { actions } from '$lib/client/actions';
	import { useApp } from '$lib/client/app.svelte';
	import { duration, weight } from '$lib/client/format';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import JobCard from '$lib/components/JobCard.svelte';
	import PrinterChip from '$lib/components/PrinterChip.svelte';

	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);

	// ---------- Filters ----------
	let query = $state('');
	let result = $state<'all' | 'Succeeded' | 'Failed' | 'Cancelled'>('all');
	let range = $state<'all' | 'week' | 'month'>('all');
	const matches = (j: Job) => {
		const q = query.trim().toLowerCase();
		if (!q) return true;
		const p = lab.project(j.projectId);
		return `${p?.title ?? ''} ${j.revision} ${j.notes} ${j.material} ${j.printerTask}`
			.toLowerCase()
			.includes(q);
	};
	const inRange = (j: Job) => {
		if (range === 'all' || !j.finishedAt) return true;
		const days = range === 'week' ? 7 : 31;
		return Date.now() - Date.parse(j.finishedAt) < days * 86_400_000;
	};

	// ---------- Drag between lanes ----------
	let dragging = $state<Job | null>(null);
	let over = $state<string | null>(null);
	type Target = { id: string; label: string; to: JobStatus | 'reprint'; tone: string };
	const targets = $derived.by((): Record<string, Target[]> => {
		const j = dragging;
		if (!j) return {};
		if (j.status === 'Queued')
			return {
				Printing: [{ id: 'start', label: 'Start printing', to: 'Printing', tone: 'Printing' }],
				Finished: [{ id: 'cancel', label: 'Cancel', to: 'Cancelled', tone: 'Idea' }]
			};
		if (j.status === 'Printing')
			return {
				Queued: [{ id: 'back', label: 'Back to the queue', to: 'Queued', tone: 'Idea' }],
				Finished: [
					{ id: 'ok', label: '✓ Succeeded', to: 'Succeeded', tone: 'Done' },
					{ id: 'bad', label: '✕ Failed', to: 'Failed', tone: 'Failed' }
				]
			};
		return {
			Queued: [
				{
					id: 'again',
					label: j.status === 'Succeeded' ? 'Print again' : 'Re-queue',
					to: 'reprint',
					tone: 'Idea'
				}
			]
		};
	});
	function drop(t: Target) {
		const j = dragging;
		dragging = null;
		over = null;
		if (!j) return;
		if (t.to === 'reprint') void act.reprint(j);
		else void act.transition(j, t.to);
	}
	const owned = $derived(new Set(lab.ownedProjects(ui.profile).map((p) => p.id)));
	const jobs = $derived(lab.ws.jobs.filter((j) => owned.has(j.projectId)));
	const queued = $derived(jobs.filter((j) => j.status === 'Queued' && matches(j)));
	const printing = $derived(jobs.filter((j) => j.status === 'Printing' && matches(j)));
	const finishedAll = $derived(
		jobs
			.filter((j) => FINISHED_JOB.has(j.status))
			.sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
	);
	const finished = $derived(
		finishedAll.filter((j) => (result === 'all' || j.status === result) && inRange(j) && matches(j))
	);
	/** Finished prints grouped by day: Today, Yesterday, then dates. */
	const days = $derived.by(() => {
		const groups: { label: string; list: Job[] }[] = [];
		const today = new Date().toDateString();
		const yesterday = new Date(Date.now() - 86_400_000).toDateString();
		for (const j of finished) {
			const d = j.finishedAt ? new Date(j.finishedAt) : null;
			const key = d?.toDateString() ?? '';
			const label = !d
				? 'Earlier'
				: key === today
					? 'Today'
					: key === yesterday
						? 'Yesterday'
						: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
			const last = groups.at(-1);
			if (last?.label === label) last.list.push(j);
			else groups.push({ label, list: [j] });
		}
		return groups;
	});
	const good = $derived(jobs.filter((j) => j.status === 'Succeeded').length);
	const bad = $derived(jobs.filter((j) => j.status === 'Failed').length);
	const consumed = $derived(jobs.filter((j) => j.status === 'Succeeded' || j.status === 'Failed'));
	const lanes = $derived([
		{
			title: 'Queued',
			tone: 'Idea',
			list: queued,
			empty: 'Nothing waiting. Queue a plate from any project.'
		},
		{ title: 'Printing', tone: 'Printing', list: printing, empty: 'The printer is free.' },
		{
			title: 'Finished',
			tone: 'Done',
			list: finished,
			empty: 'Finished prints and their results land here.'
		}
	]);
</script>

<svelte:head><title>Print jobs · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		<PageHero
			context={{ kind: 'printer' }}
			eyebrow="THE PRINT QUEUE"
			title="Print jobs"
			text="Queue a plate, start it, log how it went. Filament is deducted from the spool when a print finishes."
			note={lab.printer.connected
				? 'Preview animation — see Printer for the live print'
				: 'Preview animation — no printer is connected'}
		>
			{#snippet actions()}
				<button class="primary" onclick={() => ui.openEditor('job')}>＋ Queue a print</button>
				<PrinterChip />
			{/snippet}
			{#snippet extra()}
				<StatTiles
					label="Print job totals"
					items={[
						{
							label: 'Queued',
							value: queued.length,
							p: jobs.length ? queued.length / jobs.length : 0,
							tone: 'Idea'
						},
						{
							label: 'Printing',
							value: printing.length,
							p: printing.length ? 1 : 0,
							tone: 'Printing'
						},
						{
							label: 'Success',
							value: good + bad ? `${Math.round((good / (good + bad)) * 100)}%` : '—',
							p: good + bad ? good / (good + bad) : 0,
							tone: 'Done'
						},
						{
							label: 'Machine time',
							value: duration(
								consumed.reduce((s, j) => s + (j.actualMinutes ?? j.minutes ?? 0), 0)
							),
							p: 1,
							tone: 'Planned'
						}
					]}
				/>
			{/snippet}
		</PageHero>
		<div class="section-meta">
			<span
				>{consumed.length
					? `${weight(consumed.reduce((s, j) => s + (j.grams ?? 0), 0))} of filament used`
					: ''}</span
			><span
				>{lab.printer.connected
					? 'Linked jobs show live progress from the printer'
					: 'Progress is estimated from start time — no printer is connected'}</span
			>
		</div>
		{#if !lab.ws.projects.length}
			<div class="empty">
				<h2>No projects yet</h2>
				<p>Add a project first, then queue its prints here.</p>
			</div>
		{:else}
			<div class="jobs-toolbar">
				<label class="search"
					><span aria-hidden="true">⌕</span><input
						type="search"
						bind:value={query}
						placeholder="Search prints…"
						aria-label="Search print jobs"
					/></label
				>
				<div class="status-tabs" role="group" aria-label="Finished prints">
					{#each [['all', 'All results'], ['Succeeded', 'Succeeded'], ['Failed', 'Failed'], ['Cancelled', 'Cancelled']] as const as [id, label] (id)}
						<button
							class="status-tab"
							class:selected={result === id}
							aria-pressed={result === id}
							onclick={() => (result = id)}
							>{label}{#if id !== 'all'}<span
									>{finishedAll.filter((j) => j.status === id).length}</span
								>{/if}</button
						>
					{/each}
				</div>
				<div class="status-tabs" role="group" aria-label="Finished when">
					{#each [['all', 'Any time'], ['week', '7 days'], ['month', '31 days']] as const as [id, label] (id)}
						<button
							class="status-tab"
							class:selected={range === id}
							aria-pressed={range === id}
							onclick={() => (range = id)}>{label}</button
						>
					{/each}
				</div>
				<span class="drag-hint">Drag a card to another lane to start, finish or reprint it</span>
			</div>
			<div class="lanes" class:dragging={!!dragging}>
				{#each lanes as lane (lane.title)}
					<section class="lane t-{lane.tone}" aria-label={lane.title}>
						<header>
							<h2>{lane.title}</h2>
							<span>{lane.title === 'Finished' ? finished.length : lane.list.length}</span>
						</header>
						{#if targets[lane.title]}
							<div class="drop-zones">
								{#each targets[lane.title] as t (t.id)}
									<div
										class="drop-zone z-{t.tone}"
										class:over={over === t.id}
										role="button"
										tabindex="-1"
										aria-label={t.label}
										ondragover={(e) => {
											e.preventDefault();
											over = t.id;
										}}
										ondragleave={() => over === t.id && (over = null)}
										ondrop={(e) => {
											e.preventDefault();
											drop(t);
										}}
									>
										{t.label}
									</div>
								{/each}
							</div>
						{/if}
						{#if lane.title === 'Finished'}
							{#each days as day (day.label)}
								<h3 class="day">{day.label}</h3>
								{#each day.list as job (job.id)}<JobCard
										{job}
										now={ui.now}
										ondragstart={() => (dragging = job)}
										ondragend={() => ((dragging = null), (over = null))}
									/>{/each}
							{:else}<p class="lane-empty">
									{finishedAll.length ? 'Nothing matches these filters.' : lane.empty}
								</p>{/each}
						{:else}
							{#each lane.list as job (job.id)}<JobCard
									{job}
									now={ui.now}
									ondragstart={() => (dragging = job)}
									ondragend={() => ((dragging = null), (over = null))}
								/>{:else}<p class="lane-empty">
									{query ? 'Nothing matches.' : lane.empty}
								</p>{/each}
						{/if}
					</section>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.jobs-toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin: 4px 0 14px;
	}
	.jobs-toolbar .search {
		width: min(320px, 100%);
	}
	.drag-hint {
		margin-left: auto;
		font-size: 12px;
		color: var(--dim);
	}
	.day {
		margin: 6px 4px 0;
		font: 500 11px var(--mono);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--dim);
	}
	.drop-zones {
		display: flex;
		gap: 8px;
	}
	.drop-zone {
		flex: 1;
		display: grid;
		place-items: center;
		min-height: 64px;
		border-radius: var(--r-lg);
		border: 1.5px dashed rgb(var(--hi) / 0.25);
		color: var(--muted);
		font-size: 13px;
		font-weight: 550;
		transition:
			background 0.12s,
			border-color 0.12s,
			color 0.12s;
		animation: zone-in 0.15s ease-out;
	}
	.drop-zone.over {
		color: var(--text);
		border-style: solid;
	}
	.z-Printing.over {
		border-color: var(--amber);
		background: rgb(var(--c4) / 0.12);
	}
	.z-Done.over {
		border-color: var(--lime);
		background: rgb(var(--c3) / 0.12);
	}
	.z-Failed.over {
		border-color: var(--red);
		background: rgb(var(--c5) / 0.12);
	}
	.z-Idea.over {
		border-color: var(--violet);
		background: rgb(var(--c2) / 0.12);
	}
	@keyframes zone-in {
		from {
			opacity: 0;
			transform: scale(0.98);
		}
	}
	@media (hover: none) {
		.drag-hint {
			display: none;
		}
	}
</style>
