<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { SETTINGS_SECTION, cloudIntegration, settingsAnchor } from '$lib/client/onboarding';
	import { UI } from '$lib/client/registry';
	import {
		AI_PROVIDER_NAME,
		type AiProviderId,
		type IntegrationStatus
	} from '$lib/shared/integrations';
	import IntegrationCard from './IntegrationCard.svelte';

	// Setup guide, tools step: the slicer, the AI helpers, Blender, notifications and the optional
	// cloud link, each with its status, setup steps and a real test. All of them are optional.
	const { lab } = useApp();
	const report = $derived(lab.integrations);
	const pick = (id: string) => report?.items.find((i) => i.id === id);
	const slicer = $derived(pick('slicer'));
	const ai = $derived(report?.items.filter((i) => i.kind === 'ai') ?? []);
	const blender = $derived(pick('blender'));
	const notifications = $derived(pick('notifications'));
	const cloud = $derived(cloudIntegration(lab.cloud));
	const everywhere = $derived.by(() => {
		const r = report?.routing ?? {};
		const chosen = new Set(Object.values(r));
		return chosen.size === 1 ? ([...chosen][0] as AiProviderId) : null;
	});

	// A fresh check, since something may have just been installed.
	let checked = $state(false);
	onMount(async () => {
		await lab.loadIntegrations(true);
		checked = true;
	});

	function settingsHref(item: IntegrationStatus) {
		if (item.id === 'cloud') return lab.cloud.configured ? `${resolve('/family')}#kid-mode` : null;
		const section = SETTINGS_SECTION[item.id];
		return section && UI.settingsSections.some((s) => s.id === section)
			? `${resolve('/integrations')}#${settingsAnchor(section)}`
			: null;
	}

	async function useEverywhere(id: AiProviderId) {
		if (!report) return;
		const routing = Object.fromEntries(report.tasks.map((t) => [t.id, id]));
		const res = await lab.call(
			'PUT',
			'/api/settings',
			{ ai: { routing, models: report.models } },
			`${AI_PROVIDER_NAME[id]} will do the AI work.`
		);
		if (!res) return;
		await lab.loadIntegrations();
		// The design and chat panels read which provider does what from the AI summary.
		const summary = await fetch('/api/ai')
			.then((r) => (r.ok ? r.json() : null))
			.catch(() => null);
		if (summary) lab.ai = summary;
	}
</script>

<div class="step-body">
	<p class="lead">
		Everything here is optional and can be changed later under Settings → Integrations. Nothing is
		sent anywhere until you set it up.
	</p>
	{#if !report && (lab.checkingIntegrations || !checked)}
		<p class="dim">Checking what is installed on this computer…</p>
	{:else if !report}
		<p class="dim">
			Could not check the tools on this computer.
			<button class="mini" onclick={() => lab.loadIntegrations(true)}>Try again</button>
		</p>
	{:else}
		<h3>Slicing</h3>
		<div class="grid">
			{#if slicer}<IntegrationCard item={slicer} settingsHref={settingsHref(slicer)} />{:else}
				<p class="dim">
					No slicer is set up. You can still print files you slice in Bambu Studio (.gcode.3mf).
				</p>
			{/if}
		</div>

		<h3>AI helpers</h3>
		<p class="dim">
			Used to suggest ideas and design parts. They run through your own subscription on this
			computer; pick one to do all the AI work.
		</p>
		<div class="grid">
			{#each ai as item (item.id)}
				<IntegrationCard {item} settingsHref="{resolve('/integrations')}#integration-{item.id}">
					{#snippet actions()}
						{#if item.available}
							<button
								class="mini"
								class:primary-mini={everywhere !== item.id}
								disabled={everywhere === item.id}
								onclick={() => useEverywhere(item.id as AiProviderId)}
								>{everywhere === item.id ? 'Used for everything' : 'Use for everything'}</button
							>
						{/if}
					{/snippet}
				</IntegrationCard>
			{/each}
		</div>

		<h3>Other tools</h3>
		<div class="grid">
			{#if blender}<IntegrationCard item={blender} />{/if}
			{#if notifications}<IntegrationCard
					item={notifications}
					settingsHref={settingsHref(notifications)}
				/>{/if}
			<IntegrationCard item={cloud} settingsHref={settingsHref(cloud)} testable={false} />
		</div>
	{/if}
</div>

<style>
	.step-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.lead {
		margin: 0;
		color: var(--text-2);
		font-size: 13.5px;
	}
	h3 {
		margin: 8px 0 0;
		font-size: 14px;
	}
	.dim {
		margin: 0;
		color: var(--dim);
		font-size: 12.5px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 12px;
	}
</style>
