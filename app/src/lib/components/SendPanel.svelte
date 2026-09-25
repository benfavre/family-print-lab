<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { usePanel } from '$lib/client/panel';
	import { duration, weight } from '$lib/client/format';
	import { autoMapping, loadedSlots } from '$lib/shared/printing';
	import { ACTIVE_PRINTER_STATES } from '$lib/shared/domain';

	let { jobId, onclose }: { jobId: string; onclose: () => void } = $props();
	const { lab, ui } = useApp();
	const panel = usePanel();

	const job = $derived(lab.ws.jobs.find((j) => j.id === jobId));
	const project = $derived(lab.project(job?.projectId));
	const sliced = $derived(job?.sliced ?? null);
	// svelte-ignore state_referenced_locally
	let plateNo = $state(job?.sliced?.plate ?? 1);
	const plate = $derived(sliced?.plates.find((p) => p.index === plateNo) ?? sliced?.plates[0]);
	const status = $derived(lab.printer);
	const slots = $derived(loadedSlots(status.state));
	const busy = $derived(!!status.state && ACTIVE_PRINTER_STATES.has(status.state.gcodeState));

	let useAms = $state(true);
	let mapping = $state<number[]>([]);
	let bedLeveling = $state(true);
	let timelapse = $state(false);
	let sending = $state(false);
	let check = $state<{ blocking: string[]; warnings: string[] } | null>(null);

	$effect(() => {
		panel?.setTitle(`Print ${project?.title ?? ''} ${job?.revision ?? ''}`.trim());
	});
	// Suggest slots whenever the plate or the loaded filament changes.
	let mappedFor = '';
	$effect(() => {
		if (!plate) return;
		const key = `${plate.index}|${slots.map((s) => `${s.index}${s.type}${s.color}`).join()}`;
		if (key === mappedFor) return;
		mappedFor = key;
		mapping = autoMapping(plate.filaments, slots);
		if (!slots.length) useAms = false;
	});
	// Ask the server what it thinks, a moment after anything changes.
	$effect(() => {
		const body = {
			plate: plateNo,
			useAms,
			amsMapping: [...mapping],
			bedLeveling,
			timelapse,
			check: true
		};
		void status.connected;
		void busy;
		const timer = setTimeout(async () => {
			const r = await fetch(`/api/jobs/${jobId}/send`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}).catch(() => null);
			const data = await r?.json().catch(() => null);
			check = data?.check ?? null;
		}, 150);
		return () => clearTimeout(timer);
	});

	async function send() {
		if (!job || !check || check.blocking.length) return;
		sending = true;
		const res = await lab.call<{ task: { id: string } }>('POST', `/api/jobs/${jobId}/send`, {
			plate: plateNo,
			useAms,
			amsMapping: useAms ? mapping : [],
			bedLeveling,
			timelapse,
			force: check.warnings.length > 0
		});
		sending = false;
		if (res) {
			ui.watching.add(res.task.id);
			ui.toast('Sending to the printer…');
			onclose();
		}
	}

	const slotFor = (i: number) => slots.find((s) => s.index === mapping[i]);
</script>

{#if !job}
	<p class="panel-empty">This print job no longer exists.</p>
{:else if !sliced || !plate}
	<p class="panel-empty">Attach a sliced file (.gcode.3mf) to this job first.</p>
{:else}
	<div class="send">
		<div class="sp-printer" class:bad={!status.connected || busy}>
			<span class="dot" class:on={status.connected && !busy}></span>
			{#if !status.configured}No printer is set up yet.
			{:else if !status.connected}{status.name ?? 'Printer'} is not connected.
			{:else if busy}{status.name} is busy with “{status.state?.task}”.
			{:else}{status.name}{status.simulated ? ' (simulator)' : ''} is ready.{/if}
		</div>

		{#if sliced.plates.length > 1}
			<div class="sp-plates" role="radiogroup" aria-label="Plate">
				{#each sliced.plates as p (p.index)}
					<button
						type="button"
						role="radio"
						aria-checked={p.index === plateNo}
						onclick={() => (plateNo = p.index)}
						><img src="/api/jobs/{jobId}/sliced/thumbnail?plate={p.index}" alt="" />Plate {p.index}</button
					>
				{/each}
			</div>
		{/if}

		<div class="sp-summary">
			<img
				class="sp-thumb"
				src="/api/jobs/{jobId}/sliced/thumbnail?plate={plate.index}"
				alt="Plate {plate.index} as sliced"
				onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
			/>
			<dl>
				<div>
					<dt>Time</dt>
					<dd>{duration(plate.minutes)}</dd>
				</div>
				<div>
					<dt>Filament</dt>
					<dd>{weight(plate.grams)}</dd>
				</div>
				{#if plate.layers}<div>
						<dt>Layers</dt>
						<dd>{plate.layers}</dd>
					</div>{/if}
				<div>
					<dt>File</dt>
					<dd class="sp-file" title={sliced.name}>{sliced.name}</dd>
				</div>
			</dl>
		</div>

		<fieldset class="sp-fil">
			<legend>
				<label class="check"
					><input type="checkbox" bind:checked={useAms} /> Feed from the AMS</label
				>
			</legend>
			{#if useAms}
				{#each plate.filaments as f, i (f.id)}
					<div class="sp-row">
						<span class="sw" style:--c={f.color} aria-hidden="true"></span>
						<span class="sp-need">{f.type} <small>{weight(f.grams)}</small></span>
						<span aria-hidden="true">→</span>
						<select
							aria-label="AMS slot for filament {f.id}"
							value={mapping[i]}
							onchange={(e) => (mapping[i] = Number(e.currentTarget.value))}
						>
							<option value={-1}>Choose a slot…</option>
							{#each slots as s (s.index)}
								<option value={s.index}
									>{s.label} · {s.type}
									{s.name}{s.remain !== null && s.remain >= 0 ? ` · ${s.remain}%` : ''}</option
								>
							{/each}
						</select>
						<span class="sw" style:--c={slotFor(i)?.color ?? 'transparent'} aria-hidden="true"
						></span>
					</div>
				{/each}
				{#if !slots.length}<p class="sp-note">The printer reports no AMS filament.</p>{/if}
			{:else}
				<p class="sp-note">Prints from the spool on the external holder.</p>
			{/if}
		</fieldset>

		<div class="sp-opts">
			<label class="check"
				><input type="checkbox" bind:checked={bedLeveling} /> Level the bed first</label
			>
			<label class="check"
				><input type="checkbox" bind:checked={timelapse} /> Record a timelapse</label
			>
		</div>

		{#if check}
			{#each check.blocking as p (p)}<p class="sp-msg block">✕ {p}</p>{/each}
			{#each check.warnings as p (p)}<p class="sp-msg warn">! {p}</p>{/each}
		{/if}

		<div class="dialog-actions">
			<button type="button" class="secondary" onclick={onclose}>Not now</button>
			<button
				type="button"
				class="primary"
				disabled={sending || !check || check.blocking.length > 0}
				onclick={send}
				>{sending
					? 'Sending…'
					: check?.warnings.length
						? 'Send anyway'
						: 'Send and start printing'}</button
			>
		</div>
	</div>
{/if}

<style>
	.send {
		display: grid;
		gap: 14px;
		padding-bottom: 14px;
	}
	.sp-printer {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--muted);
	}
	.sp-printer.bad {
		color: var(--amber);
	}
	.sp-printer .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--amber);
	}
	.sp-printer .dot.on {
		background: var(--lime);
	}
	.sp-plates {
		display: flex;
		gap: 8px;
		overflow-x: auto;
	}
	.sp-plates button {
		display: grid;
		gap: 4px;
		justify-items: center;
		padding: 6px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: transparent;
		color: var(--muted);
		font-size: 12px;
	}
	.sp-plates button[aria-checked='true'] {
		border-color: var(--cyan);
		color: var(--text);
	}
	.sp-plates img {
		width: 72px;
		height: 72px;
		object-fit: contain;
	}
	.sp-summary {
		display: grid;
		grid-template-columns: 120px 1fr;
		gap: 14px;
		align-items: center;
	}
	.sp-thumb {
		width: 120px;
		height: 120px;
		object-fit: contain;
		border-radius: var(--r-md);
		background: rgb(var(--hi) / 0.04);
		border: 1px solid var(--line);
	}
	dl {
		margin: 0;
		display: grid;
		gap: 4px;
	}
	dl div {
		display: flex;
		gap: 10px;
		font-size: 13px;
	}
	dt {
		width: 64px;
		color: var(--dim);
	}
	dd {
		margin: 0;
		font-weight: 550;
		min-width: 0;
	}
	.sp-file {
		font-weight: 400;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sp-fil {
		margin: 0;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		display: grid;
		gap: 8px;
	}
	.sp-fil legend {
		padding: 0 4px;
		font-size: 13px;
	}
	.sp-row {
		display: grid;
		grid-template-columns: 16px minmax(80px, auto) auto 1fr 16px;
		align-items: center;
		gap: 8px;
		font-size: 13px;
	}
	.sp-row select {
		min-width: 0;
	}
	.sp-need small {
		color: var(--dim);
	}
	.sw {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--c);
		box-shadow: 0 0 0 1px var(--line-strong) inset;
	}
	.sp-note {
		margin: 0;
		font-size: 12.5px;
		color: var(--dim);
	}
	.sp-opts {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 18px;
		font-size: 13px;
	}
	.sp-msg {
		margin: 0;
		font-size: 12.5px;
	}
	.sp-msg.block {
		color: var(--red);
	}
	.sp-msg.warn {
		color: var(--amber);
	}
	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
</style>
