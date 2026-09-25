<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { INTEGRATION_GLYPH } from '$lib/client/integrations';
	import {
		AI_PROVIDERS,
		AI_PROVIDER_NAME,
		type AiProviderId,
		type IntegrationStatus,
		type IntegrationTest
	} from '$lib/shared/integrations';
	import { stamp } from '$lib/client/format';

	const { lab, ui } = useApp();
	const report = $derived(lab.integrations);
	const ai = $derived(report?.items.filter((i) => i.kind === 'ai') ?? []);
	const tools = $derived(report?.items.filter((i) => i.kind !== 'ai') ?? []);
	const readyCount = $derived(report?.items.filter((i) => i.available).length ?? 0);

	let tests = $state<Record<string, { running: boolean; result: IntegrationTest | null }>>({});
	let routing = $state<Record<string, AiProviderId>>({});
	let models = $state<Record<AiProviderId, string>>({
		'claude-code': '',
		codex: '',
		'anthropic-api': ''
	});
	let synced = false;
	$effect(() => {
		if (report && !synced) {
			routing = { ...report.routing };
			models = { ...report.models };
			synced = true;
		}
	});

	onMount(() => void lab.loadIntegrations());

	const MODEL_HINT: Record<AiProviderId, { hint: string; options: string[] }> = {
		'claude-code': {
			hint: 'Alias or model ID; blank uses Claude Code’s default.',
			options: ['opus', 'sonnet', 'haiku']
		},
		codex: { hint: 'Model name; blank uses your Codex default.', options: [] },
		'anthropic-api': {
			hint: 'Claude API model ID.',
			options: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']
		}
	};
	const TEST_LABEL: Record<string, string> = {
		ai: 'Say hello',
		blender: 'Repair a test mesh',
		openscad: 'Render a test part',
		printer: 'Check the connection'
	};

	async function test(item: IntegrationStatus) {
		tests[item.id] = { running: true, result: null };
		try {
			const r = await fetch(`/api/integrations/${item.id}/test`, { method: 'POST' });
			const data = await r.json();
			tests[item.id] = {
				running: false,
				result: r.ok ? data : { ok: false, ms: 0, detail: data.error ?? 'Test failed.' }
			};
		} catch {
			tests[item.id] = {
				running: false,
				result: { ok: false, ms: 0, detail: 'Could not reach the app server.' }
			};
		}
		void lab.loadIntegrations();
	}

	async function save() {
		const res = await lab.call(
			'PUT',
			'/api/settings',
			{ ai: { routing: $state.snapshot(routing), models: $state.snapshot(models) } },
			'Saved.'
		);
		if (!res) return;
		await lab.loadIntegrations();
		const summary = await fetch('/api/ai')
			.then((r) => (r.ok ? r.json() : null))
			.catch(() => null);
		if (summary) lab.ai = summary;
	}
	function everything(id: AiProviderId) {
		for (const t of report?.tasks ?? []) routing[t.id] = id;
		void save();
	}
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			ui.toast('Copied.');
		} catch {
			ui.toast(text);
		}
	}
	const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
</script>

<svelte:head><title>Integrations · Family Print Lab</title></svelte:head>

<header class="int-head">
	<div>
		<div class="eyebrow">CONNECTED TOOLS</div>
		<h1>Integrations</h1>
		<p>
			The lab designs with <strong>Claude</strong> and <strong>ChatGPT</strong> through your
			subscriptions, models in
			<strong>OpenSCAD</strong> and <strong>Blender</strong>, and follows the
			<strong>printer</strong>. Here is what each one does and whether it is ready.
		</p>
	</div>
	<div class="head-side">
		{#if report}
			<span class="ready-count"><b>{readyCount}</b> of {report.items.length} ready</span>
			<span class="checked">Checked {stamp(report.checkedAt)}</span>
		{/if}
		<button
			class="secondary"
			disabled={lab.checkingIntegrations}
			onclick={() => lab.loadIntegrations(true)}
			>{lab.checkingIntegrations ? 'Checking…' : 'Check again'}</button
		>
	</div>
</header>

{#snippet card(item: IntegrationStatus)}
	{@const t = tests[item.id]}
	<article class="int-card" class:ready={item.available} data-integration={item.id}>
		<header>
			<span class="mark" aria-hidden="true">{INTEGRATION_GLYPH[item.id]}</span>
			<div class="title">
				<h3>{item.name}</h3>
				<span class="via">{item.via}</span>
			</div>
			<span class="state">{item.available ? 'Ready' : 'Not ready'}</span>
		</header>
		<p class="int-detail">
			{item.detail}{#if item.version && item.kind !== 'ai'}<br /><span class="version"
					>{item.version}</span
				>{/if}
		</p>
		{#if item.powers.length}
			<div class="powers" aria-label="Used for">
				{#each item.powers as p (p)}<span>{p}</span>{/each}
			</div>
		{:else if item.kind === 'ai'}
			<p class="idle">Not used for anything yet.</p>
		{/if}
		{#if item.kind === 'ai'}
			{@const id = item.id as AiProviderId}
			<label class="int-model"
				><span>Model</span><input
					list="models-{id}"
					bind:value={models[id]}
					maxlength="60"
					placeholder="Default"
					onchange={save}
				/></label
			>
			<datalist id="models-{id}"
				>{#each MODEL_HINT[id].options as o (o)}<option value={o}></option>{/each}</datalist
			>
			<small class="hint">{MODEL_HINT[id].hint}</small>
		{/if}
		{#if !item.available && item.setup.length}
			<ol class="int-setup">
				{#each item.setup as step (step.text)}
					<li>
						<span>{step.text}</span>
						{#if step.command}
							<span class="cmd"
								><code>{step.command}</code><button
									type="button"
									class="mini icon"
									aria-label="Copy command"
									onclick={() => copy(step.command!)}>⧉</button
								></span
							>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
		<div class="int-actions">
			<button class="mini" disabled={t?.running} onclick={() => test(item)}
				>{t?.running
					? 'Testing…'
					: `Test: ${TEST_LABEL[item.kind === 'ai' ? 'ai' : item.id]}`}</button
			>
			{#if item.kind === 'ai' && item.available}
				<button class="mini" onclick={() => everything(item.id as AiProviderId)}
					>Use for everything</button
				>
			{/if}
		</div>
		{#if t?.result}
			<p class="result" class:bad={!t.result.ok} role="status">
				{t.result.ok ? '✓' : '✕'}
				{t.result.detail}
				{#if t.result.ms}<span class="ms">{seconds(t.result.ms)}</span>{/if}
			</p>
		{/if}
	</article>
{/snippet}

{#if !report}
	<p class="panel-empty loading">Checking Claude Code, Codex, Blender and the printer…</p>
{:else}
	<section class="int-section">
		<h2>AI</h2>
		<p class="section-lead">
			Subscriptions run through the official command-line tools, signed in on this computer, with
			every tool and file access switched off, so they can only answer. Keep the app for your own
			family’s use.
		</p>
		<div class="int-grid">
			{#each ai as item (item.id)}{@render card(item)}{/each}
		</div>
	</section>

	<section class="int-section">
		<h2>Which AI does what</h2>
		<p class="section-lead">
			Designing parts benefits most from the strongest model. You can also pick per request in the
			design and edit panels.
		</p>
		<div class="routing">
			{#each report.tasks as task (task.id)}
				{@const chosen = report.items.find((i) => i.id === routing[task.id])}
				<label class="route">
					<span>{task.label}</span>
					<span class="choices" role="radiogroup" aria-label={task.label}>
						{#each AI_PROVIDERS as p (p)}
							{@const item = report.items.find((i) => i.id === p)}
							<button
								type="button"
								role="radio"
								aria-checked={routing[task.id] === p}
								class:off={!item?.available}
								title={item?.available ? item.via : `${item?.via} — not ready`}
								onclick={() => {
									routing[task.id] = p;
									void save();
								}}
								><span aria-hidden="true">{INTEGRATION_GLYPH[p]}</span>{AI_PROVIDER_NAME[p]}</button
							>
						{/each}
					</span>
					{#if chosen && !chosen.available}<small class="warn"
							>{chosen.name} is not ready, so this will fail.</small
						>{/if}
				</label>
			{/each}
		</div>
	</section>

	<section class="int-section">
		<h2>Making and printing</h2>
		<div class="int-grid">
			{#each tools as item (item.id)}{@render card(item)}{/each}
		</div>
	</section>
{/if}

<style>
	.int-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 24px;
		flex-wrap: wrap;
		padding: 28px 0 20px;
	}
	.int-head h1 {
		margin: 6px 0;
		font-size: 30px;
	}
	.int-head p {
		margin: 0;
		max-width: 72ch;
		color: var(--muted);
	}
	.int-head strong {
		color: var(--text-2);
		font-weight: 550;
	}
	.head-side {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.ready-count {
		font-size: 13px;
		color: var(--muted);
	}
	.ready-count b {
		color: var(--lime);
		font-size: 16px;
	}
	.checked {
		font-size: 12px;
		color: var(--dim);
	}
	.int-section {
		margin-bottom: 26px;
	}
	.int-section h2 {
		font-size: 15px;
		margin: 0 0 4px;
	}
	.section-lead {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
		max-width: 90ch;
	}
	.int-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 12px;
	}
	.int-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px;
		border-radius: var(--r-lg);
		border: 1px solid var(--line);
		background: var(--panel);
	}
	.int-card.ready {
		border-color: rgb(var(--c3) / 0.3);
	}
	.int-card > header {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.mark {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		flex-shrink: 0;
		border-radius: 10px;
		font-size: 18px;
		color: var(--dim);
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
	}
	.ready .mark {
		color: var(--cyan);
		background: rgb(var(--c1) / 0.1);
		box-shadow: 0 0 0 1px rgb(var(--c1) / 0.3) inset;
	}
	.title {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.title h3 {
		margin: 0;
		font-size: 15px;
	}
	.via {
		font-size: 12px;
		color: var(--dim);
	}
	.state {
		font-size: 11.5px;
		padding: 2px 9px;
		border-radius: 999px;
		color: var(--err-text);
		box-shadow: 0 0 0 1px rgb(var(--c5) / 0.4) inset;
	}
	.ready .state {
		color: var(--lime);
		box-shadow: 0 0 0 1px rgb(var(--c3) / 0.4) inset;
	}
	.int-detail {
		margin: 0;
		font-size: 12.5px;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	.version {
		font: 11.5px var(--mono);
		color: var(--dim);
	}
	.powers {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.powers span {
		font-size: 11.5px;
		padding: 2px 8px;
		border-radius: 999px;
		background: rgb(var(--c1) / 0.08);
		color: var(--text-2);
	}
	.idle {
		margin: 0;
		font-size: 12px;
		color: var(--dim);
	}
	.int-model {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--muted);
	}
	.int-model input {
		flex: 1;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.03);
		padding: 5px 8px;
		color: var(--text);
		font: 12.5px var(--mono);
	}
	.hint {
		font-size: 11.5px;
		color: var(--dim);
		margin-top: -6px;
	}
	.int-setup {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 12.5px;
		color: var(--amber);
	}
	.int-setup li > span:first-child {
		color: var(--text-2);
	}
	.cmd {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 3px;
	}
	.cmd code {
		flex: 1;
		font-size: 11.5px;
		padding: 5px 8px;
		border-radius: 6px;
		background: rgb(var(--hi) / 0.05);
		color: var(--text);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.int-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: auto;
		padding: 0;
	}
	.result {
		margin: 0;
		font-size: 12.5px;
		color: var(--lime);
		line-height: 1.45;
	}
	.result.bad {
		color: var(--err-text);
	}
	.ms {
		color: var(--dim);
		margin-left: 6px;
		font-variant-numeric: tabular-nums;
	}
	.routing {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
		gap: 12px 20px;
		padding: 14px 16px;
		border-radius: var(--r-lg);
		border: 1px solid var(--line);
		background: var(--panel);
	}
	.route {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--muted);
	}
	.choices {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
		align-self: flex-start;
	}
	.choices button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		font-size: 12.5px;
		padding: 5px 10px;
	}
	.choices button.off {
		opacity: 0.5;
	}
	.choices button[aria-checked='true'] {
		background: rgb(var(--c1) / 0.16);
		color: var(--text);
		box-shadow: 0 0 0 1px rgb(var(--c1) / 0.45) inset;
		opacity: 1;
	}
	.warn {
		color: var(--amber);
		font-weight: 400;
	}
	.loading {
		padding: 40px 0;
	}
</style>
