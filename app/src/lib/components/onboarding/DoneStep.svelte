<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { actions } from '$lib/client/actions';
	import { PRINTER_MODELS } from '$lib/shared/printers/models';

	// Setup guide, last step: what is set up, and a first print from a file sliced in Bambu Studio
	// (a project and a job are made for it, then the usual send window opens).
	let { ongo }: { ongo: (step: 'printer' | 'family') => void } = $props();
	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);
	const printers = $derived(lab.ws.printers ?? []);
	const profiles = $derived(lab.ws.profiles);
	const ready = $derived(lab.integrations?.items.filter((i) => i.available).length ?? 0);
	let printerId = $state<string | null>(null);
	const chosen = $derived(printers.find((p) => p.id === printerId) ?? printers[0] ?? null);
	let busy = $state(false);
	let fileInput = $state<HTMLInputElement>();

	onMount(
		() =>
			void fetch('/api/onboarding', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'finish' })
			}).catch(() => {})
	);

	// The job made for the first print, kept so a failed upload (wrong file) does not leave a second
	// "First print" project behind when the next file is chosen.
	let firstJob = $state<string | null>(null);

	async function firstPrint(file: File) {
		if (!chosen) return;
		// Checked before anything is made (attachSliced checks again).
		if (!/\.3mf$/i.test(file.name))
			return ui.toast('Choose the sliced file (.gcode.3mf) from Bambu Studio.', 'error');
		// Grown-ups own the first project; kid profiles only when there is nobody else.
		const owner = profiles.find((p) => !p.kid) ?? profiles[0];
		if (!owner) return;
		busy = true;
		try {
			let job = lab.ws.jobs.find((j) => j.id === firstJob && !j.sliced) ?? null;
			if (job && job.printerId !== chosen.id) {
				const moved = await lab.call('PATCH', `/api/jobs/${job.id}`, {
					printerId: chosen.id,
					version: job.version
				});
				if (!moved) return;
				job = lab.ws.jobs.find((j) => j.id === firstJob) ?? null;
			}
			if (!job) {
				const project = await lab.call<{ id: string }>('POST', '/api/projects', {
					profileId: owner.id,
					title: 'First print',
					status: 'Planned',
					description: 'Printed from the setup guide.'
				});
				if (!project) return;
				const created = await lab.call<{ id: string }>('POST', '/api/jobs', {
					projectId: project.id,
					revision: file.name.replace(/\.gcode\.3mf$|\.3mf$/i, '').slice(0, 80),
					printerId: chosen.id
				});
				if (!created) return;
				firstJob = created.id;
				job = lab.ws.jobs.find((j) => j.id === created.id) ?? null;
			}
			if (!job || !(await act.attachSliced(job, file))) return;
			ui.openSend(job.id, chosen.id);
		} finally {
			busy = false;
		}
	}
</script>

<div class="step-body">
	<ul class="summary" aria-label="What is set up">
		<li class:ok={printers.length}>
			<span aria-hidden="true">{printers.length ? '✓' : '○'}</span>
			{#if printers.length}
				{printers.length === 1 ? printers[0].name : `${printers.length} printers`} added
			{:else}
				No printer yet. <button class="link" onclick={() => ongo('printer')}>Add one</button>
			{/if}
		</li>
		<li class:ok={ready}>
			<span aria-hidden="true">{ready ? '✓' : '○'}</span>
			{ready} of {lab.integrations?.items.length ?? 0} tools ready (see Settings → Integrations)
		</li>
		<li class:ok={profiles.length}>
			<span aria-hidden="true">{profiles.length ? '✓' : '○'}</span>
			{#if profiles.length}
				{profiles.length === 1 ? '1 person' : `${profiles.length} people`} in the family
			{:else}
				Nobody in the family yet. <button class="link" onclick={() => ongo('family')}
					>Add someone</button
				>
			{/if}
		</li>
	</ul>

	<section class="first" aria-labelledby="first-print">
		<h3 id="first-print">Your first print</h3>
		{#if !printers.length}
			<p class="dim">Add a printer first.</p>
		{:else if !profiles.length}
			<p class="dim">Add a family member first; the print is saved as their project.</p>
		{:else}
			<p>
				Slice a model in Bambu Studio, export the plate (File → Export → Export plate sliced file),
				then choose the .gcode.3mf here. It opens the send window, where you pick the AMS slots.
			</p>
			<div class="row">
				{#if printers.length > 1}
					<label class="field inline"
						>Printer<select bind:value={printerId}>
							{#each printers as p (p.id)}<option value={p.id}
									>{p.name} ({PRINTER_MODELS[p.model].short})</option
								>{/each}
						</select></label
					>
				{/if}
				<button class="primary" disabled={busy} onclick={() => fileInput?.click()}
					>{busy ? 'Getting it ready…' : 'Choose a sliced file'}</button
				>
				<input
					bind:this={fileInput}
					type="file"
					accept=".3mf,model/3mf"
					hidden
					aria-label="Sliced file for the first print"
					onchange={async (e) => {
						const file = e.currentTarget.files?.[0];
						e.currentTarget.value = '';
						if (file) await firstPrint(file);
					}}
				/>
			</div>
		{/if}
	</section>

	<div class="row">
		<button class="secondary" onclick={() => goto(resolve('/'))}>Go to projects</button>
		{#if printers.length}
			<button class="secondary" onclick={() => goto(resolve('/printers'))}>See the printers</button>
		{/if}
	</div>
</div>

<style>
	.step-body {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.summary {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
		font-size: 13.5px;
		color: var(--muted);
	}
	.summary li span {
		display: inline-block;
		width: 18px;
		color: var(--dim);
	}
	.summary li.ok {
		color: var(--text-2);
	}
	.summary li.ok span {
		color: var(--lime);
	}
	.link {
		border: 0;
		padding: 0;
		background: none;
		color: var(--cyan);
		font: inherit;
		text-decoration: underline;
	}
	.first {
		padding: 14px 16px;
		border-radius: var(--r-lg);
		border: 1px solid rgb(var(--c1) / 0.3);
		background: rgb(var(--c1) / 0.05);
	}
	.first h3 {
		margin: 0 0 6px;
		font-size: 14px;
	}
	.first p {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--text-2);
	}
	.dim {
		color: var(--dim) !important;
	}
	.row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: flex-end;
	}
	.field.inline {
		margin: 0;
		min-width: 200px;
	}
</style>
