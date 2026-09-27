<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import type { CalibrationData } from '$lib/client/modules/slicer-calibration/store.svelte';
	import {
		CALIB_TESTS,
		roundSetting,
		volumetricAtHeight,
		type CalibRun,
		type CalibStep
	} from '$lib/shared/slicer-calibration';
	import TestPicture from './TestPicture.svelte';

	// One calibration run: slicing, then printing (queue or the job's own send), then reading the print
	// and saving the winning value into the filament preset and the spool.
	let { run, data, queue }: { run: CalibRun; data: CalibrationData; queue: boolean } = $props();
	const { lab } = useApp();

	const test = $derived(CALIB_TESTS[run.kind]);
	const printer = $derived(lab.printerById(run.printerId));
	const spool = $derived(lab.ws.spools.find((s) => s.id === run.spoolId) ?? null);
	const job = $derived(lab.ws.jobs.find((j) => j.id === run.jobId) ?? null);
	const task = $derived(lab.tasks.find((t) => t.id === run.taskId) ?? null);

	let chosen = $state<number | null>(null);
	let height = $state<number | null>(null);
	let custom = $state<number | null>(null);
	let save = $state(true);
	let busy = $state(false);

	const heightValue = $derived(
		height !== null && height > 0 ? volumetricAtHeight(run.params, height) : null
	);
	const value = $derived(
		custom ??
			(test.pick === 'height' ? heightValue : chosen !== null ? run.steps[chosen]?.value : null)
	);
	const shown = (v: number) =>
		test.setting ? String(roundSetting(test.setting.key, v)) : String(Math.round(v * 1000) / 1000);

	/** "−5 %" or "+0.01" for flow blocks, else the printed label with its unit. */
	function stepLabel(s: CalibStep): string {
		if (run.kind === 'flow_rate' && run.baseFlowRatio) {
			const m = s.label.replace(/^flowrate_/, '').replace(/^m/, '−');
			return run.params.linear ? `${m.startsWith('−') ? '' : '+'}${m}` : `${m} %`;
		}
		return `${s.label}${test.unit ? ` ${test.unit}` : ''}`;
	}

	async function enqueue() {
		busy = true;
		try {
			await data.write('POST', `/runs/${run.id}/queue`, {}, 'Added to the print queue.');
		} finally {
			busy = false;
		}
	}

	async function saveResult(e: SubmitEvent) {
		e.preventDefault();
		if (value === null || busy) return;
		busy = true;
		try {
			const label =
				custom !== null
					? 'typed in'
					: test.pick === 'height'
						? `measured ${height} mm`
						: chosen !== null
							? stepLabel(run.steps[chosen])
							: '';
			await data.write(
				'POST',
				`/runs/${run.id}/result`,
				{ value, label, save: save && !!test.setting && !!run.filament },
				test.setting && save && run.filament
					? `${test.setting.label} saved to your preset.`
					: 'Result noted.'
			);
		} finally {
			busy = false;
		}
	}
</script>

<article class="panel run">
	<header class="panel-head">
		<div>
			<h2>{run.title || test.title}</h2>
			<p class="sub">
				{printer?.name ?? 'Printer removed'}{#if spool}
					· {[spool.brand, spool.material, spool.colorName]
						.filter(Boolean)
						.join(' ')}{/if}{#if run.filament}
					· {run.filament.name}{/if}
			</p>
		</div>
		<span class="state {run.status}"
			>{run.status === 'slicing'
				? 'Slicing'
				: run.status === 'ready'
					? 'Ready to print'
					: run.status === 'done'
						? 'Done'
						: 'Failed'}</span
		>
	</header>

	{#if run.status === 'slicing'}
		<p class="panel-empty">{task?.stage ?? 'Print Lab Slicer is making the test…'}</p>
	{:else if run.status === 'failed'}
		<p class="error-text" role="alert">{run.error ?? 'Something went wrong.'}</p>
		<button class="mini" onclick={() => data.remove(run.id)}>Remove</button>
	{:else}
		<div class="print">
			{#if job}
				<span
					>Job {job.revision}: {job.status}{job.minutes
						? ` · about ${Math.round(job.minutes)} min`
						: ''}</span
				>
				<a class="mini" href={resolve('/projects/[id]', { id: job.projectId })}>Open the job</a>
				{#if queue && job.status === 'Queued'}
					<button class="mini primary-mini" onclick={enqueue} disabled={busy}
						>Add to the print queue</button
					>
				{/if}
			{:else}
				<span class="muted">The job was deleted.</span>
			{/if}
		</div>

		{#if run.status === 'done' && run.result}
			<p class="saved">
				{test.setting ? `${test.setting.label}: ` : 'Best: '}<b
					>{shown(run.result.value)}{test.unit ? ` ${test.unit}` : ''}</b
				>{#if run.result.label}
					({run.result.label}){/if}.
				{#if run.result.preset}
					Saved to “{run.result.preset.name}”{run.result.spoolUpdated
						? ', which the spool now slices with'
						: ''}.
				{:else if run.kind === 'vfa'}
					Keep outer walls at or below this speed.
				{/if}
			</p>
		{/if}

		<details open={run.status === 'ready'}>
			<summary>{run.status === 'done' ? 'Pick again' : 'Read the print'}</summary>
			<div class="read">
				<TestPicture kind={run.kind} label={test.title} />
				<ol>
					{#each test.read as line, i (i)}<li>{line}</li>{/each}
				</ol>
			</div>
			<form onsubmit={saveResult}>
				{#if test.pick === 'height'}
					<label class="field"
						>Height where it first failed (mm)<input
							type="number"
							step="0.1"
							min="0"
							bind:value={height}
						/>
						{#if heightValue !== null}<small>That is {heightValue} {test.unit}.</small>{/if}</label
					>
				{:else}
					<div class="steps" role="radiogroup" aria-label="Pick the best one">
						{#each run.steps as s, i (i)}
							<button
								type="button"
								role="radio"
								aria-checked={chosen === i}
								class:chosen={chosen === i}
								onclick={() => {
									chosen = i;
									custom = null;
								}}
							>
								<b>{stepLabel(s)}</b>
								{#if run.kind === 'flow_rate'}<small>{shown(s.value)}</small>
								{:else if s.zMin !== undefined}<small>{s.zMin}–{s.zMax} mm</small>{/if}
							</button>
						{/each}
					</div>
				{/if}
				<div class="fields-row">
					<label class="field"
						>Or type the value<input type="number" step="any" bind:value={custom} /></label
					>
					{#if test.setting}
						<label class="toggle"
							><input type="checkbox" bind:checked={save} disabled={!run.filament} /> Save to the
							filament preset{run.spoolId ? ' and the spool' : ''}</label
						>
					{/if}
				</div>
				<button class="mini primary-mini" type="submit" disabled={value === null || busy}
					>{value === null
						? 'Pick the best one'
						: `Use ${shown(value)}${test.unit ? ` ${test.unit}` : ''}`}</button
				>
				<button class="mini" type="button" onclick={() => data.remove(run.id)}>Remove</button>
			</form>
		</details>
	{/if}
</article>

<style>
	.run h2 {
		font-size: 14px;
	}
	.sub {
		margin: 2px 0 0;
		color: var(--dim);
		font-size: 12px;
	}
	.state {
		font-size: 12px;
		padding: 3px 9px;
		border-radius: 999px;
		border: 1px solid var(--line);
		color: var(--muted);
		white-space: nowrap;
	}
	.state.ready {
		color: var(--cyan);
		border-color: var(--cyan);
	}
	.state.done {
		color: var(--done);
	}
	.state.failed {
		color: var(--err-text);
		border-color: var(--err-text);
	}
	.print {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		margin-bottom: 10px;
	}
	.saved {
		font-size: 13px;
		margin: 0 0 10px;
	}
	details summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 550;
		margin-bottom: 8px;
	}
	.read {
		display: grid;
		grid-template-columns: minmax(120px, 200px) 1fr;
		gap: 14px;
		align-items: start;
		margin-bottom: 10px;
	}
	.read ol {
		margin: 0;
		padding-left: 18px;
		font-size: 13px;
		color: var(--text-2);
		display: grid;
		gap: 6px;
	}
	.steps {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 12px;
	}
	.steps button {
		display: grid;
		gap: 1px;
		padding: 5px 9px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: transparent;
		color: var(--text);
		font-size: 12.5px;
		cursor: pointer;
		text-align: left;
	}
	.steps button small {
		color: var(--dim);
		font-size: 11px;
	}
	.steps button.chosen {
		border-color: var(--cyan);
		background: rgb(var(--c1) / 0.1);
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		align-self: end;
		margin-bottom: 14px;
	}
	.error-text {
		color: var(--err-text);
		font-size: 13px;
		margin: 0 0 8px;
	}
	.muted {
		color: var(--dim);
	}
	@media (max-width: 640px) {
		.read {
			grid-template-columns: 1fr;
		}
	}
</style>
