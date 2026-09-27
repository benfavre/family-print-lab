<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { galleryImageUrl, type GalleryItem } from '$lib/shared/kids';
	import Avatar from '../Avatar.svelte';

	// Photos of things the family made. Grown-ups get the certificate link and can remove photos.
	let { items }: { items: GalleryItem[] } = $props();
	const { lab, ui } = useApp();

	const day = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric'
		});

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
				<p class="caption">{item.caption || item.projectTitle || 'Something we made'}</p>
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
</style>
