<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { galleryImageUrl, type GalleryItem } from '$lib/shared/kids';
	import Avatar from '../Avatar.svelte';

	// Photos of things the family made. Grown-ups get the certificate link, can change a caption and
	// remove photos.
	let { items }: { items: GalleryItem[] } = $props();
	const { lab, ui } = useApp();

	const day = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric'
		});

	let editing = $state<string | null>(null);
	let caption = $state('');

	function edit(item: GalleryItem) {
		editing = item.id;
		caption = item.caption;
	}

	async function saveCaption(e: SubmitEvent, item: GalleryItem) {
		e.preventDefault();
		if (await lab.call('PATCH', `/api/kids/gallery/${item.id}`, { caption }, 'Caption saved.'))
			editing = null;
	}

	async function remove(item: GalleryItem) {
		if (
			await ui.ask(
				'Remove this photo?',
				'It leaves the family gallery for good. The print job and badges stay.',
				'Remove'
			)
		)
			await lab.call('DELETE', `/api/kids/gallery/${item.id}`, undefined, 'Photo removed.');
	}
</script>

<ul class="gallery">
	{#each items as item (item.id)}
		{@const maker = lab.profile(item.profileId)}
		<li class="photo">
			<img
				src={galleryImageUrl(item.id)}
				alt={item.caption || item.projectTitle || 'A print'}
				loading="lazy"
			/>
			<div class="photo-body">
				{#if editing === item.id}
					<form class="caption-form" onsubmit={(e) => saveCaption(e, item)}>
						<!-- svelte-ignore a11y_autofocus -->
						<input
							aria-label="Caption"
							maxlength="200"
							placeholder={item.projectTitle ?? 'Something we made'}
							bind:value={caption}
							autofocus
							onkeydown={(e) => e.key === 'Escape' && (editing = null)}
						/>
						<button class="mini primary">Save</button>
					</form>
				{:else}
					<p class="caption">{item.caption || item.projectTitle || 'Something we made'}</p>
				{/if}
				<p class="meta">
					<Avatar profile={maker} />
					<span
						>{maker?.name ?? 'Someone'} · {day(item.createdAt)}{item.source === 'camera'
							? ' · 📷 printer camera'
							: ''}</span
					>
				</p>
				<div class="photo-actions">
					{#if item.jobId}
						<a class="mini" href={resolve('/family/certificate/[jobId]', { jobId: item.jobId })}
							>🏅 Certificate</a
						>
					{/if}
					<button
						class="mini icon edit"
						aria-label="Change caption"
						title="Change caption"
						onclick={() => edit(item)}>✎</button
					>
					<button
						class="mini icon"
						aria-label="Remove photo"
						title="Remove photo"
						onclick={() => remove(item)}>✕</button
					>
				</div>
			</div>
		</li>
	{/each}
</ul>

<style>
	.gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 14px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.photo {
		display: grid;
		grid-template-rows: auto 1fr;
		border: 1px solid var(--line);
		border-radius: var(--r-lg);
		background: var(--panel);
		overflow: hidden;
	}
	.photo img {
		width: 100%;
		aspect-ratio: 4 / 3;
		object-fit: cover;
		background: var(--panel-strong);
	}
	.photo-body {
		display: grid;
		gap: 6px;
		padding: 10px 12px 12px;
	}
	.photo-body p {
		margin: 0;
	}
	.caption {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--muted);
		font-size: 12.5px;
	}
	.meta :global(.avatar) {
		width: 22px;
		height: 22px;
		font-size: 9px;
	}
	.photo-actions {
		display: flex;
		justify-content: space-between;
		gap: 6px;
		margin-top: 2px;
	}
	.photo-actions a {
		text-decoration: none;
	}
	.photo-actions .edit {
		margin-left: auto;
	}
	.caption-form {
		display: flex;
		gap: 6px;
	}
	.caption-form input {
		flex: 1;
		min-width: 0;
	}
</style>
