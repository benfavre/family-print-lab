<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { stamp } from '$lib/client/format';

	interface Backup {
		file: string;
		size: number;
		createdAt: string;
		reason: string;
		models: number;
	}
	interface Listing {
		dir: string;
		mirror: { dir: string | null; ok: boolean; problem: string };
		backups: Backup[];
	}

	const { lab, ui } = useApp();
	let listing = $state<Listing | null>(null);
	let working = $state<string | null>(null);

	const REASON: Record<string, string> = {
		daily: 'Daily',
		manual: 'Made by hand',
		'before-import': 'Before an import',
		'before-restore': 'Before a restore'
	};
	const size = (b: number) =>
		b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toFixed(1)} MB`;

	async function load() {
		listing = await lab.call<Listing>('GET', '/api/backups');
	}
	onMount(() => void load());

	async function now() {
		working = 'new';
		if (await lab.call('POST', '/api/backups', undefined, 'Backup saved.')) await load();
		working = null;
	}
	async function restore(b: Backup) {
		const ok = await ui.ask(
			`Go back to ${stamp(b.createdAt)}?`,
			'Projects, jobs, filament, models and sketches return to how they were then. What you have now is saved first as a backup, so this can be undone.',
			'Restore'
		);
		if (!ok) return;
		working = b.file;
		const res = await lab.call<{ restored: { rows: number; files: number } }>(
			'POST',
			'/api/backups/restore',
			{ file: b.file }
		);
		working = null;
		if (res) {
			ui.toast(`Restored from ${stamp(b.createdAt)}.`);
			await load();
		}
	}
</script>

<section class="int-section" id="backups" aria-label="Backups">
	<div class="bk-head">
		<div>
			<h2>Backups</h2>
			<p class="section-lead">
				A full copy (projects, jobs, filament, models and sketches) is saved every day and before
				any import or restore; the last 14 are kept.
			</p>
		</div>
		<button class="secondary" disabled={!!working} onclick={now}
			>{working === 'new' ? 'Saving…' : 'Back up now'}</button
		>
	</div>

	{#if listing}
		<div class="bk-where">
			<span>Saved in <code>{listing.dir}</code></span>
			{#if listing.mirror.dir}
				<span class:bad={!listing.mirror.ok}
					>{listing.mirror.ok ? '✓ Also copied to' : '⚠ Not copied to'}
					<code>{listing.mirror.dir}</code>{#if listing.mirror.problem}: {listing.mirror
							.problem}{/if}</span
				>
			{:else}
				<span class="hint"
					>Only on this disk. Set <code>BACKUP_MIRROR</code> to a folder on another disk to keep a second
					copy.</span
				>
			{/if}
		</div>
		{#if listing.backups.length}
			<ol class="bk-list">
				{#each listing.backups as b, i (b.file)}
					<li>
						<span class="bk-when">{stamp(b.createdAt)}</span>
						<span class="bk-why">{REASON[b.reason] ?? b.reason}</span>
						<span class="bk-size"
							>{size(b.size)}{#if b.models}
								· {b.models} model file{b.models === 1 ? '' : 's'}{/if}</span
						>
						{#if i > 0 || b.reason !== 'before-restore'}
							<button
								class="mini"
								disabled={!!working}
								onclick={() => restore(b)}
								aria-label="Restore the backup from {stamp(b.createdAt)}"
								>{working === b.file ? 'Restoring…' : 'Restore'}</button
							>
						{/if}
					</li>
				{/each}
			</ol>
		{:else}
			<p class="panel-empty">No backups yet.</p>
		{/if}
	{:else}
		<p class="panel-empty">Loading…</p>
	{/if}
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
	.bk-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
		flex-wrap: wrap;
	}
	.bk-where {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin-bottom: 10px;
		font-size: 12.5px;
		color: var(--muted);
	}
	.bk-where .bad {
		color: var(--amber);
	}
	.bk-where .hint {
		color: var(--dim);
	}
	.bk-where code {
		font-size: 11.5px;
		word-break: break-all;
	}
	.bk-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		max-width: 760px;
	}
	.bk-list li {
		display: grid;
		grid-template-columns: minmax(130px, auto) 1fr auto auto;
		align-items: center;
		gap: 12px;
		padding: 8px 12px;
		font-size: 13px;
	}
	.bk-list li + li {
		border-top: 1px solid var(--line);
	}
	.bk-when {
		font-variant-numeric: tabular-nums;
	}
	.bk-why {
		color: var(--muted);
	}
	.bk-size {
		color: var(--dim);
		font-size: 12px;
	}
	@media (max-width: 560px) {
		.bk-list li {
			grid-template-columns: 1fr auto;
		}
		.bk-why,
		.bk-size {
			grid-column: 1;
		}
		.bk-list .mini {
			grid-column: 2;
			grid-row: 1 / span 3;
		}
	}
</style>
