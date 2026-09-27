<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { shrinkPhoto } from '$lib/client/modules/kids/photo';

	// Adds a photo to the family gallery: for a finished print (jobId) or just for a maker (profileId).
	let {
		jobId = null,
		profileId = null,
		label = '📷 Add a photo',
		mini = false
	}: {
		jobId?: string | null;
		profileId?: string | null;
		label?: string;
		mini?: boolean;
	} = $props();
	const { lab, ui } = useApp();
	let busy = $state(false);

	async function pick(e: Event & { currentTarget: HTMLInputElement }) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!file || busy) return;
		busy = true;
		try {
			const image = await shrinkPhoto(file);
			await lab.call(
				'POST',
				'/api/kids/gallery',
				{ jobId, profileId, image },
				'Photo added to the gallery.'
			);
		} catch (error) {
			ui.toast((error as Error).message || 'That photo could not be read.', 'error');
		} finally {
			busy = false;
		}
	}
</script>

<label class="upload {mini ? 'mini' : 'secondary'}" class:busy aria-busy={busy}>
	{busy ? 'Adding…' : label}
	<input type="file" accept="image/*" capture="environment" onchange={pick} disabled={busy} />
</label>

<style>
	.upload {
		position: relative;
		cursor: pointer;
	}
	.upload input {
		position: absolute;
		inset: 0;
		opacity: 0;
		width: 100%;
		cursor: pointer;
	}
	.upload:has(input:focus-visible) {
		outline: 2px solid var(--cyan);
		outline-offset: 2px;
	}
	.busy {
		opacity: 0.7;
	}
</style>
