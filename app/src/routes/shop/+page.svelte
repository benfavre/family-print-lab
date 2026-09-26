<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { projectHref } from '$lib/client/actions';
	import PageHero from '$lib/components/PageHero.svelte';

	interface Item {
		id: string;
		kind: 'kid-pack' | 'part' | 'model';
		kindLabel: string;
		title: string;
		blurb: string;
		description: string;
		price: number | null;
		plan: boolean;
		facts: string[];
		owned: boolean;
	}
	interface Shop {
		linked: boolean;
		configured: boolean;
		catalogue: { items: Item[]; balance: number; plan: boolean; site: string } | null;
		installed: Record<string, { projectId: string | null }>;
	}

	const { lab, ui } = useApp();
	let shop = $state<Shop | null>(null);
	let problem = $state('');
	let busy = $state<string | null>(null);
	let kind = $state<'all' | Item['kind']>('all');
	let open = $state<string | null>(null);

	// Parts and models become a project for this person.
	const grownUps = $derived(lab.ws.profiles.filter((p) => !p.kid));
	let profileId = $state('');
	$effect(() => {
		if (!profileId || !lab.ws.profiles.some((p) => p.id === profileId))
			profileId =
				ui.profile !== 'all' && lab.ws.profiles.some((p) => p.id === ui.profile)
					? ui.profile
					: (grownUps[0]?.id ?? lab.ws.profiles[0]?.id ?? '');
	});

	const KINDS = [
		['all', 'Everything'],
		['kid-pack', 'Kid mode packs'],
		['part', 'Customizable parts'],
		['model', 'Ready-made models']
	] as const;
	const items = $derived(
		(shop?.catalogue?.items ?? []).filter((i) => kind === 'all' || i.kind === kind)
	);
	const credits = $derived(shop?.catalogue?.balance ?? 0);

	async function load() {
		problem = '';
		try {
			const r = await fetch(resolve('/api/shop'));
			const data = await r.json();
			if (!r.ok) throw new Error(data.error ?? 'Could not load the shop.');
			shop = data;
		} catch (e) {
			problem = (e as Error).message;
		}
	}
	onMount(() => {
		void load();
		// Bought on the website meanwhile? Show it when coming back to the app.
		const again = () => document.visibilityState === 'visible' && void load();
		document.addEventListener('visibilitychange', again);
		return () => document.removeEventListener('visibilitychange', again);
	});

	async function install(item: Item) {
		busy = item.id;
		const res = await lab.call<{ projectId: string | null }>(
			'POST',
			`/api/shop/${item.id}/install`,
			{ profileId },
			item.kind === 'kid-pack' ? `${item.title}: it is now in kid mode.` : undefined
		);
		busy = null;
		await load();
		if (res?.projectId) {
			ui.toast(`${item.title} is ready in a new project.`);
			await goto(projectHref(res.projectId));
		}
	}

	async function buy(item: Item) {
		const ok = await ui.ask(
			`Buy ${item.title}?`,
			`${item.price} credits from your Print Lab Cloud account (you have ${credits}). It is yours to keep and installs right away.`,
			'Buy'
		);
		if (!ok) return;
		busy = item.id;
		const res = await lab.call('POST', `/api/shop/${item.id}/buy`);
		busy = null;
		if (res) await install(item);
		else await load();
	}
</script>

<svelte:head><title>Shop · Family Print Lab</title></svelte:head>

<div class="page">
	<PageHero
		eyebrow="SHOP"
		title="Things to print"
		text="Customizable parts, ready-made models and kid mode packs, designed and tested by us. Bought with your Print Lab Cloud credits, yours to keep, installed in one click."
		note="Preview animation"
	>
		{#snippet actions()}
			{#if shop?.catalogue}
				<span class="credits"><strong>{credits}</strong> credits</span>
				<!-- eslint-disable svelte/no-navigation-without-resolve -- the cloud's own site -->
				<a
					class="ghost-button"
					href="{shop.catalogue.site}/account#credits"
					target="_blank"
					rel="noopener">Get credits</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/if}
		{/snippet}
	</PageHero>

	{#if problem}
		<p class="panel-empty" role="alert">{problem}</p>
	{:else if !shop}
		<p class="panel-empty">Loading the shop…</p>
	{:else if !shop.linked}
		<section class="panel shop-intro">
			<h2>Link Print Lab Cloud to shop</h2>
			<p>
				The shop uses your Print Lab Cloud account and its credits.
				{#if shop.configured}Link this computer on the Family page (it takes a minute), then come
					back here.{:else}This installation has no cloud address (CLOUD_URL).{/if}
			</p>
			{#if shop.configured}<a class="primary-link" href={resolve('/family')}
					>Go to the Family page</a
				>{/if}
		</section>
	{:else}
		<div class="shop-bar">
			<div class="segmented" role="tablist" aria-label="Show">
				{#each KINDS as [value, label] (value)}
					<button
						role="tab"
						aria-selected={kind === value}
						class:active={kind === value}
						onclick={() => (kind = value)}>{label}</button
					>
				{/each}
			</div>
			<label class="for"
				>Parts and models go to
				<select bind:value={profileId}>
					{#each lab.ws.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</select></label
			>
		</div>

		<div class="shop-grid">
			{#each items as item (item.id)}
				{@const done = shop.installed[item.id]}
				<article class="shop-card">
					<button
						class="shop-pic"
						onclick={() => (open = open === item.id ? null : item.id)}
						aria-expanded={open === item.id}
						aria-label="More about {item.title}"
						><img
							src={resolve('/api/shop/image/[id]', { id: item.id })}
							alt=""
							loading="lazy"
						/></button
					>
					<div class="shop-body">
						<span class="kind">{item.kindLabel}</span>
						<h3>{item.title}</h3>
						<p>{open === item.id ? item.description : item.blurb}</p>
						{#if open === item.id}
							<ul class="facts">
								{#each item.facts as f (f)}<li>{f}</li>{/each}
							</ul>
						{/if}
						<div class="shop-actions">
							{#if item.owned}
								{#if item.kind === 'kid-pack'}
									{#if done}<span class="owned">✓ In kid mode</span>{:else}<button
											class="primary"
											disabled={!!busy}
											onclick={() => install(item)}
											>{busy === item.id ? 'Adding…' : 'Add to kid mode'}</button
										>{/if}
								{:else if done?.projectId && lab.ws.projects.some((p) => p.id === done.projectId)}
									<a class="primary-link" href={projectHref(done.projectId)}>Open project</a>
									<button class="mini" disabled={!!busy} onclick={() => install(item)}
										>Install again</button
									>
								{:else}
									<button class="primary" disabled={!!busy} onclick={() => install(item)}
										>{busy === item.id ? 'Installing…' : 'Install'}</button
									>
								{/if}
							{:else if item.plan}
								<span class="plan">With the Family plan</span>
							{:else}
								<span class="price"><strong>{item.price}</strong> credits</span>
								<button
									class="primary"
									disabled={!!busy || credits < (item.price ?? 0)}
									title={credits < (item.price ?? 0) ? 'Not enough credits yet' : undefined}
									onclick={() => buy(item)}>{busy === item.id ? 'Buying…' : 'Buy'}</button
								>
							{/if}
						</div>
					</div>
				</article>
			{/each}
		</div>
		<p class="licence">
			For your family: print, change and give away the prints as much as you like. Please do not
			share or sell the files.
		</p>
	{/if}
</div>

<style>
	.credits {
		align-self: center;
		font-size: 14px;
		color: var(--muted);
	}
	.credits strong {
		font-size: 20px;
		color: var(--text);
	}
	.shop-intro {
		max-width: 640px;
		padding: 20px;
	}
	.shop-intro h2 {
		margin: 0 0 6px;
		font-size: 16px;
	}
	.shop-intro p {
		margin: 0 0 12px;
		color: var(--muted);
	}
	.shop-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin: 6px 0 16px;
	}
	.segmented {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.segmented button {
		padding: 6px 12px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
	}
	.segmented button.active {
		color: var(--text);
		border-color: var(--cyan);
		background: rgb(var(--raise));
	}
	.for {
		display: flex;
		gap: 8px;
		align-items: center;
		font-size: 13px;
		color: var(--muted);
	}
	.shop-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
		gap: 16px;
	}
	.shop-card {
		display: grid;
		grid-template-rows: auto 1fr;
		border: 1px solid var(--line);
		border-radius: var(--r-lg, 16px);
		background: rgb(var(--surface));
		overflow: hidden;
	}
	.shop-pic {
		display: block;
		padding: 0;
		border: 0;
		background: #e2e2e4;
		cursor: pointer;
	}
	.shop-pic img {
		display: block;
		width: 100%;
		aspect-ratio: 4 / 3;
		object-fit: cover;
	}
	.shop-body {
		display: grid;
		gap: 6px;
		align-content: start;
		padding: 12px 14px 14px;
	}
	.kind {
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--cyan);
	}
	h3 {
		margin: 0;
		font-size: 15px;
	}
	.shop-body p {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	.facts {
		margin: 2px 0 0;
		padding-left: 18px;
		font-size: 12.5px;
		color: var(--text-2);
	}
	.shop-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 6px;
	}
	.price {
		font-size: 13px;
		color: var(--muted);
		margin-right: auto;
	}
	.price strong {
		font-size: 17px;
		color: var(--text);
	}
	.owned,
	.plan {
		font-size: 13px;
		color: var(--lime);
	}
	.plan {
		color: var(--muted);
	}
	.licence {
		margin: 18px 0 0;
		font-size: 12.5px;
		color: var(--dim);
	}
</style>
