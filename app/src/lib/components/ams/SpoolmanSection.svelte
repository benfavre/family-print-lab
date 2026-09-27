<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import type { SpoolmanView } from '$lib/shared/ams';

	// Settings → Spoolman: an optional self-hosted spool inventory. Off by default; nothing is sent
	// until it is turned on.
	const { lab } = useApp();
	let view = $state<SpoolmanView | null>(null);
	let f = $state({ enabled: false, url: '', token: '', pushUsage: true });
	let busy = $state(false);
	let result = $state<{ ok: boolean; text: string } | null>(null);

	function adopt(v: SpoolmanView | undefined) {
		if (!v) return;
		view = v;
		f = { enabled: v.enabled, url: v.url, token: '', pushUsage: v.pushUsage };
	}
	onMount(async () => {
		try {
			const r = await fetch('/api/spoolman');
			if (r.ok) adopt(await r.json());
		} catch {
			/* shown as unavailable below */
		}
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const r = await lab.call<{ spoolman: SpoolmanView }>(
			'PUT',
			'/api/spoolman',
			{
				enabled: f.enabled,
				url: f.url,
				pushUsage: f.pushUsage,
				...(f.token && { token: f.token })
			},
			'Spoolman settings saved.'
		);
		busy = false;
		adopt(r?.spoolman);
	}
	async function run(path: 'test' | 'import' | 'pull') {
		busy = true;
		result = null;
		const r = await lab.call<{
			detail?: string;
			added?: number;
			skipped?: number;
			updated?: number;
		}>('POST', `/api/spoolman/${path}`, {});
		busy = false;
		if (!r) return;
		result = {
			ok: true,
			text:
				path === 'test'
					? (r.detail ?? 'Spoolman answered.')
					: path === 'import'
						? `${r.added} spool${r.added === 1 ? '' : 's'} added to the shelf${r.skipped ? `, ${r.skipped} already there or archived` : ''}.`
						: `${r.updated} spool weight${r.updated === 1 ? '' : 's'} updated from Spoolman.`
		};
	}
</script>

<section class="int-section" id="spoolman" aria-label="Spoolman">
	<div class="section-head">
		<h2>Spoolman</h2>
	</div>
	<p class="section-lead">
		If you keep your spools in <strong>Spoolman</strong> on your own network, the shelf can import them
		and record what each print used there. Nothing is sent to Spoolman until you turn this on.
	</p>
	{#if view}
		<form class="spoolman" onsubmit={save}>
			<label class="toggle"><input type="checkbox" bind:checked={f.enabled} /> Use Spoolman</label>
			<div class="fields-row">
				<label class="field"
					>Address<input
						bind:value={f.url}
						maxlength="300"
						placeholder="http://192.168.1.10:7912"
						autocomplete="off"
						required={f.enabled}
					/></label
				>
				<label class="field"
					>Token (optional)<input
						type="password"
						bind:value={f.token}
						maxlength="500"
						autocomplete="off"
						placeholder={view.hasToken ? 'Saved; leave empty to keep' : 'Only behind a proxy'}
					/></label
				>
			</div>
			<label class="toggle"
				><input type="checkbox" bind:checked={f.pushUsage} /> Record each print’s usage in Spoolman</label
			>
			{#if view.lastError}<p class="result bad" role="status">✕ {view.lastError}</p>{/if}
			{#if result}<p class="result" role="status">✓ {result.text}</p>{/if}
			<div class="actions">
				<button class="primary" disabled={busy}>Save</button>
				{#if view.enabled}
					<button type="button" class="secondary" disabled={busy} onclick={() => run('test')}
						>Check the connection</button
					>
					<button type="button" class="secondary" disabled={busy} onclick={() => run('import')}
						>Import spools</button
					>
					<button type="button" class="secondary" disabled={busy} onclick={() => run('pull')}
						>Update weights</button
					>
				{/if}
			</div>
		</form>
	{:else}
		<p class="panel-empty">AMS sync is not running, so Spoolman is unavailable.</p>
	{/if}
</section>

<style>
	.spoolman {
		display: grid;
		gap: 8px;
		max-width: 640px;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.result {
		margin: 0;
		font-size: 13px;
		color: var(--lime);
	}
	.result.bad {
		color: var(--red);
	}
</style>
