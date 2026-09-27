<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import type { HmsSettings } from '$lib/shared/hms';

	const { lab } = useApp();
	let settings = $state<HmsSettings | null>(null);
	let error = $state('');
	let saving = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/api/hms/settings');
			if (!res.ok) throw new Error('Could not load printer error settings.');
			settings = await res.json();
		} catch {
			error = 'Could not load printer error settings.';
		}
	});

	async function save(language: string) {
		saving = true;
		try {
			const result = await lab.call<HmsSettings>(
				'PUT',
				'/api/hms/settings',
				{ language },
				'Printer error language saved.'
			);
			if (result) settings = result;
		} finally {
			saving = false;
		}
	}
</script>

<section class="int-section" id="hms" aria-labelledby="hms-settings-title">
	<h2 id="hms-settings-title">Printer error help</h2>
	<p class="section-lead">Error messages work offline. Missing translations use English.</p>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{:else if settings}
		<label
			>Message language
			<select
				value={settings.language}
				disabled={saving}
				onchange={(e) => save(e.currentTarget.value)}
			>
				<option value="en">English</option>
				<option value="fr">Français</option>
			</select>
		</label>
	{:else}
		<p class="section-lead">Loading…</p>
	{/if}
</section>
