<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import PhotoUpload from './PhotoUpload.svelte';

	// What a grown-up can do with a finished kid print that has no photo yet.
	let { jobId, camera }: { jobId: string; camera: boolean } = $props();
	const { lab } = useApp();
	let taking = $state(false);

	async function capture() {
		if (taking) return;
		taking = true;
		try {
			await lab.call(
				'POST',
				`/api/kids/photos/${jobId}/capture`,
				{},
				'Photo added to the gallery.'
			);
		} finally {
			taking = false;
		}
	}
</script>

<span class="wanted-actions">
	<PhotoUpload {jobId} mini />
	{#if camera}
		<button class="mini" disabled={taking} aria-busy={taking} onclick={capture}
			>{taking ? 'Taking a photo…' : 'Printer camera'}</button
		>
	{/if}
	<button class="mini" onclick={() => lab.call('POST', `/api/kids/photos/${jobId}/dismiss`, {})}
		>No photo</button
	>
	<a class="mini" href={resolve('/family/certificate/[jobId]', { jobId })}>Certificate</a>
</span>

<style>
	.wanted-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.wanted-actions a {
		text-decoration: none;
	}
</style>
