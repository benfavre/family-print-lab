<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { INTEGRATION_GLYPH, integrationGlyph } from '$lib/client/integrations';
	import {
		SETTINGS_SECTION,
		cloudIntegration,
		groupIntegrations,
		settingsAnchor
	} from '$lib/client/onboarding';
	import { UI, type SettingsSection } from '$lib/client/registry';
	import IntegrationCard from '$lib/components/onboarding/IntegrationCard.svelte';
	import {
		AI_PROVIDERS,
		AI_PROVIDER_NAME,
		type AiProviderId,
		type IntegrationStatus
	} from '$lib/shared/integrations';
	import { stamp } from '$lib/client/format';

	// Settings → Integrations: one card per integration (the built-in ones, every module's rows and
	// the Print Lab Cloud link), grouped by what they are for, then the settings sections packages
	// register, each under its own anchor so a card's Settings link can jump there.
	const { lab } = useApp();
	const report = $derived(lab.integrations);
	const cloud = $derived(cloudIntegration(lab.cloud));
	const items = $derived(report ? [...report.items, cloud] : []);
	const groups = $derived(groupIntegrations(items));
	// Settings sections from the UI registry: printers first, then the AI blocks below, then the
	// other groups in this order, with the system ones (backups) last.
	const GROUPS: SettingsSection['group'][] = [
		'printing',
		'integrations',
		'notifications',
		'family',
		'privacy'
	];
	const sections = (group: SettingsSection['group']) =>
		UI.settingsSections.filter((s) => s.group === group);
	const readyCount = $derived(items.filter((i) => i.available).length);

	/** Where an integration is set up: its registered settings section, or the Family page for the cloud. */
	function settingsHref(item: IntegrationStatus): string | null {
		if (item.id === 'cloud') return lab.cloud.configured ? `${resolve('/family')}#kid-mode` : null;
		const section = SETTINGS_SECTION[item.id];
		return section && UI.settingsSections.some((s) => s.id === section)
			? `#${settingsAnchor(section)}`
			: null;
	}

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
</script>

<svelte:head><title>Integrations · Family Print Lab</title></svelte:head>

<header class="int-head">
	<div>
		<div class="eyebrow">CONNECTED TOOLS</div>
		<h1>Integrations</h1>
		<p>
			The lab designs with <strong>Claude</strong> and <strong>ChatGPT</strong> through your
			subscriptions, models in
			<strong>OpenSCAD</strong> and <strong>Blender</strong>, slices, and follows the
			<strong>printers</strong>. Here is what each one does and whether it is ready.
		</p>
	</div>
	<div class="head-side">
		{#if report}
			<span class="ready-count"><b>{readyCount}</b> of {items.length} ready</span>
			<span class="checked">Checked {stamp(report.checkedAt)}</span>
		{/if}
		<a class="secondary" href={resolve('/welcome')}>Setup guide</a>
		<button
			class="secondary"
			disabled={lab.checkingIntegrations}
			onclick={() => lab.loadIntegrations(true)}
			>{lab.checkingIntegrations ? 'Checking…' : 'Check again'}</button
		>
	</div>
</header>

{#if report}
	<nav class="jump" aria-label="Jump to an integration">
		{#each items as item (item.id)}
			<a href="#integration-{item.id}" class:ready={item.available} data-jump={item.id}
				><span aria-hidden="true">{integrationGlyph(item.id)}</span>{item.name}<span class="sr-only"
					>{item.available ? ', ready' : ', not ready'}</span
				></a
			>
		{/each}
	</nav>
{/if}

{#each sections('printers') as section (section.id)}
	<div id={settingsAnchor(section.id)} class="anchor"><section.component /></div>
{/each}

{#snippet aiFields(item: IntegrationStatus)}
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
{/snippet}

{#snippet card(item: IntegrationStatus)}
	{#if item.kind === 'ai'}
		<IntegrationCard {item}>
			{@render aiFields(item)}
			{#snippet actions()}
				{#if item.available}
					<button class="mini" onclick={() => everything(item.id as AiProviderId)}
						>Use for everything</button
					>
				{/if}
			{/snippet}
		</IntegrationCard>
	{:else}
		<IntegrationCard {item} settingsHref={settingsHref(item)} testable={item.id !== 'cloud'} />
	{/if}
{/snippet}

{#if !report}
	<p class="panel-empty loading">Checking Claude Code, Codex, Blender and the printers…</p>
{:else}
	{#each groups as group (group.id)}
		<section class="int-section" aria-labelledby="group-{group.id}">
			<h2 id="group-{group.id}">{group.title}</h2>
			<p class="section-lead">{group.lead}</p>
			<div class="int-grid">
				{#each group.items as item (item.id)}{@render card(item)}{/each}
			</div>
		</section>
		{#if group.id === 'ai'}
			<section class="int-section">
				<h2>Which AI does what</h2>
				<p class="section-lead">
					Designing parts benefits most from the strongest model. You can also pick per request in
					the design and edit panels.
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
										><span aria-hidden="true">{INTEGRATION_GLYPH[p]}</span>{AI_PROVIDER_NAME[
											p
										]}</button
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
		{/if}
	{/each}
{/if}

{#each GROUPS as group (group)}
	{#each sections(group) as section (section.id)}
		<div id={settingsAnchor(section.id)} class="anchor"><section.component /></div>
	{/each}
{/each}
{#each sections('system') as section (section.id)}
	<div id={settingsAnchor(section.id)} class="anchor"><section.component /></div>
{/each}

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
	.jump {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: -4px 0 22px;
	}
	.jump a {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px;
		border-radius: 999px;
		font-size: 12px;
		color: var(--muted);
		text-decoration: none;
		box-shadow: 0 0 0 1px rgb(var(--c5) / 0.35) inset;
	}
	.jump a.ready {
		color: var(--text-2);
		box-shadow: 0 0 0 1px rgb(var(--c3) / 0.35) inset;
	}
	.jump a:hover {
		background: rgb(var(--hi) / 0.05);
	}
	.jump a span[aria-hidden] {
		color: var(--dim);
	}
	.jump a.ready span[aria-hidden] {
		color: var(--cyan);
	}
	.anchor {
		scroll-margin-top: 80px;
	}
	.loading {
		padding: 40px 0;
	}
</style>
