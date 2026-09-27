<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { cameraPrefs } from '$lib/client/modules/camera/settings.svelte';
	import type { CameraSettings } from '$lib/shared/camera';

	// Integrations → Cameras: whether printer cards show a small live picture.
	const { lab } = useApp();
	onMount(() => void cameraPrefs.load());

	async function save(patch: Partial<CameraSettings>) {
		const next = { ...cameraPrefs.value, ...patch };
		const res = await lab.call<{ settings: CameraSettings }>('PUT', '/api/camera/settings', next);
		if (res) cameraPrefs.value = res.settings;
	}
</script>

<section class="int-section" id="cameras" aria-labelledby="cameras-title">
	<h2 id="cameras-title">Cameras</h2>
	<p class="section-lead">
		Each printer’s page shows its live camera. Pictures stay on your network: the app talks to the
		printer directly and never sends them anywhere.
	</p>
	<label class="option"
		><input
			type="checkbox"
			checked={cameraPrefs.value.showOnCards}
			disabled={!cameraPrefs.loaded}
			onchange={(e) => save({ showOnCards: e.currentTarget.checked })}
		/> Show camera on printer cards (a new picture every 10 seconds)</label
	>
</section>

<style>
	.int-section {
		margin-bottom: 26px;
		scroll-margin-top: 80px;
	}
	h2 {
		font-size: 15px;
		margin: 0 0 4px;
	}
	.section-lead {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
		max-width: 90ch;
	}
	.option {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
	}
</style>
