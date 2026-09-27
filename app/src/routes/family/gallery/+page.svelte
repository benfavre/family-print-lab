<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { kidsFeed } from '$lib/client/modules/kids/feed.svelte';
	import type { GalleryItem, KidsOverview } from '$lib/shared/kids';
	import Avatar from '$lib/components/Avatar.svelte';
	import GalleryGrid from '$lib/components/kids/GalleryGrid.svelte';
	import PhotoUpload from '$lib/components/kids/PhotoUpload.svelte';
	import PhotoWantedActions from '$lib/components/kids/PhotoWantedActions.svelte';

	const { lab } = useApp();
	// ?profile=<id> opens the gallery on one maker.
	let only = $state<string | null>(page.url.searchParams.get('profile'));
	const gallery = kidsFeed<{ items: GalleryItem[] }>(lab, () => '/api/kids/gallery');
	const overview = kidsFeed<KidsOverview>(lab, () => '/api/kids');
	const items = $derived(gallery.data?.items ?? []);
	const shown = $derived(only ? items.filter((i) => i.profileId === only) : items);
	// Makers with photos, and every kid (so a child's filter exists before their first photo).
	const makers = $derived(
		lab.ws.profiles.filter((p) => p.kid || items.some((i) => i.profileId === p.id))
	);
	const wanted = $derived(
		(overview.data?.photosWanted ?? []).filter((w) => !only || w.profileId === only)
	);
	let uploadFor = $state('');
	$effect(() => {
		if (!lab.ws.profiles.some((p) => p.id === uploadFor))
			uploadFor = only ?? makers[0]?.id ?? lab.ws.profiles[0]?.id ?? '';
	});
</script>

<svelte:head><title>Family gallery · Family Print Lab</title></svelte:head>

<div class="gallery-page">
	<header class="gallery-head">
		<div>
			<a class="back" href={resolve('/family')}>← Family</a>
			<h1>Family gallery</h1>
			<p>
				Photos of everything the family made. Open a certificate to print and put on the fridge.
			</p>
		</div>
		{#if lab.ws.profiles.length}
			<div class="add">
				<label class="field"
					>Add a photo for
					<select bind:value={uploadFor}>
						{#each lab.ws.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
					</select>
				</label>
				{#if uploadFor}<PhotoUpload profileId={uploadFor} />{/if}
			</div>
		{/if}
	</header>

	{#if makers.length > 1}
		<div class="filters" role="group" aria-label="Whose photos">
			<button class="chip" aria-pressed={!only} onclick={() => (only = null)}>Everyone</button>
			{#each makers as p (p.id)}
				<button class="chip" aria-pressed={only === p.id} onclick={() => (only = p.id)}
					><Avatar profile={p} />{p.name}</button
				>
			{/each}
		</div>
	{/if}

	{#if wanted.length}
		<section class="panel wanted" aria-labelledby="wanted-title">
			<h2 id="wanted-title" class="panel-title">Waiting for a photo</h2>
			<ul>
				{#each wanted as w (w.jobId)}
					<li>
						<span
							><strong>{lab.profile(w.profileId)?.name ?? 'A kid'}</strong> made {w.projectTitle}</span
						>
						<PhotoWantedActions jobId={w.jobId} camera={!!overview.data?.cameraAvailable} />
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if gallery.error}
		<p class="error">{gallery.error}</p>
	{:else if !gallery.data}
		<p class="hint">Loading…</p>
	{:else if shown.length}
		<GalleryGrid items={shown} />
	{:else}
		<div class="empty">
			<h2>No photos yet</h2>
			<p>
				When a kid’s print finishes, add a photo of it here (or let the printer camera take one: see
				Kids at a glance on the Family page).
			</p>
		</div>
	{/if}
</div>

<style>
	.gallery-page {
		display: grid;
		gap: 18px;
	}
	.gallery-head {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		align-items: flex-end;
		justify-content: space-between;
	}
	.gallery-head h1 {
		margin: 6px 0 4px;
		font-size: 28px;
		letter-spacing: -0.02em;
	}
	.gallery-head p {
		margin: 0;
		max-width: 60ch;
		color: var(--muted);
	}
	.back {
		color: var(--muted);
		font-size: 13px;
		text-decoration: none;
	}
	.add {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}
	.add .field {
		margin: 0;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip[aria-pressed='true'] {
		background: rgb(var(--c1) / 0.16);
		color: var(--text);
		box-shadow: 0 0 0 1px rgb(var(--c1) / 0.5) inset;
	}
	.wanted ul {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.wanted li {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		justify-content: space-between;
	}
	.hint {
		color: var(--muted);
	}
</style>
