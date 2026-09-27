<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import type { ImportSettingsView } from '$lib/shared/model-import';
	import { importCall } from './api';
	import { importWindows } from './state.svelte';

	// Integrations → Model links: what link import does, and the optional Thingiverse app token.
	const { lab, ui } = useApp();
	let settings = $state<ImportSettingsView | null>(null);
	let token = $state('');
	let saving = $state(false);
	let error = $state('');

	onMount(async () => {
		try {
			settings = await importCall<ImportSettingsView>(lab, 'GET', '/api/imports/settings');
		} catch (err) {
			error = (err as Error).message;
		}
	});

	async function save(value: string) {
		saving = true;
		error = '';
		try {
			const data = await importCall<{ settings: ImportSettingsView }>(
				lab,
				'PUT',
				'/api/imports/settings',
				{ thingiverseToken: value }
			);
			settings = data.settings;
			token = '';
			ui.toast(value ? 'Thingiverse token saved.' : 'Thingiverse token removed.');
		} catch (err) {
			error = (err as Error).message;
		} finally {
			saving = false;
		}
	}
</script>

<section class="int-section" id="model-links" aria-labelledby="model-links-title">
	<div class="section-head">
		<h2 id="model-links-title">Model links</h2>
		<button class="secondary" onclick={() => importWindows.openLink()}>Import from a link</button>
	</div>
	<p class="section-lead">
		Paste a Printables, Thingiverse or MakerWorld link to start a project with the designer’s
		credit, the licence, pictures and, where the site allows, the files. The app asks the site only
		when you look up a link. You can also drop STL, 3MF or OBJ files anywhere in the app.
	</p>
	<form
		class="token"
		onsubmit={(e) => {
			e.preventDefault();
			void save(token.trim());
		}}
	>
		<label class="field"
			>Thingiverse app token<input
				bind:value={token}
				type="password"
				autocomplete="off"
				maxlength="200"
				placeholder={settings?.hasThingiverseToken
					? 'Saved. Type a new one to replace it'
					: 'Optional'}
			/><small
				>Thingiverse only answers apps with a token. Create a free app at
				thingiverse.com/apps/create and paste its app token here. It stays on this computer.</small
			></label
		>
		<div class="token-actions">
			<button class="primary" disabled={saving || !token.trim()}>Save token</button>
			{#if settings?.hasThingiverseToken}
				<button type="button" class="ghost-button" disabled={saving} onclick={() => save('')}
					>Remove token</button
				>
			{/if}
			{#if error}<span class="error" role="alert">{error}</span>{/if}
		</div>
	</form>
</section>

<style>
	.int-section {
		margin-bottom: 26px;
	}
	.int-section h2 {
		font-size: 15px;
		margin: 0 0 4px;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.section-lead {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
		max-width: 90ch;
	}
	.token {
		max-width: 560px;
	}
	.token-actions {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}
	.error {
		color: var(--err-text);
		font-size: 13px;
	}
</style>
