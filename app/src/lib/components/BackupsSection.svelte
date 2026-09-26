<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { stamp } from '$lib/client/format';
	import type { CloudBackup } from '$lib/shared/cloud';

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

	// ---------- Cloud backup (Family plan): sealed here with a key only the family has ----------
	const cloud = $derived(lab.cloud);
	const linked = $derived(cloud.configured && !!cloud.account);
	let recoveryKey = $state<string | null>(null);
	let cloudList = $state<CloudBackup[] | null>(null);
	let keyFor = $state<string | null>(null);
	let keyInput = $state('');

	async function cloudAction(action: 'enable' | 'disable' | 'now') {
		working = `cloud-${action}`;
		const res = await lab.call<{ recoveryKey?: string }>(
			'POST',
			'/api/cloud/backup',
			{ action },
			action === 'now' ? 'Encrypted backup sent to Print Lab Cloud.' : undefined
		);
		working = null;
		if (res?.recoveryKey) recoveryKey = res.recoveryKey;
		if (action === 'now') await load();
	}
	async function showKey() {
		const res = await lab.call<{ recoveryKey: string | null }>('GET', '/api/cloud/backup');
		recoveryKey = res?.recoveryKey ?? null;
	}
	async function copyKey() {
		try {
			await navigator.clipboard.writeText(recoveryKey ?? '');
			ui.toast('Recovery key copied. Keep it somewhere safe, away from this computer.');
		} catch {
			ui.toast('Select the key and copy it by hand.', 'error');
		}
	}
	async function loadCloud() {
		working = 'cloud-list';
		cloudList =
			(await lab.call<{ backups: CloudBackup[] }>('GET', '/api/cloud/backups'))?.backups ?? null;
		working = null;
	}
	async function restoreCloud(b: CloudBackup) {
		if (!b.ours && keyFor !== b.id) {
			keyFor = b.id;
			keyInput = '';
			return;
		}
		const ok = await ui.ask(
			`Go back to the cloud backup of ${stamp(b.createdAt)}?`,
			`From ${b.device}. Projects, jobs, filament, models and sketches return to how they were then. What you have now is saved first as a backup, so this can be undone.`,
			'Restore'
		);
		if (!ok) return;
		working = b.id;
		const res = await lab.call<{ restored: { rows: number } }>(
			'POST',
			'/api/cloud/backups/restore',
			{
				id: b.id,
				...(b.ours ? {} : { recoveryKey: keyInput })
			}
		);
		working = null;
		if (res) {
			keyFor = null;
			ui.toast(`Restored from the cloud backup of ${stamp(b.createdAt)}.`);
			await load();
		}
	}

	const REASON: Record<string, string> = {
		daily: 'Daily',
		manual: 'Made by hand',
		'before-import': 'Before an import',
		'before-restore': 'Before a restore',
		'from-cloud': 'From the cloud'
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

	{#if cloud.configured}
		<div class="bk-cloud" aria-label="Cloud backup">
			<h3>Cloud backup</h3>
			{#if !linked}
				<p class="section-lead">
					Keep an encrypted copy online with the Family plan: link this computer to Print Lab Cloud
					on the Family page first.
				</p>
			{:else if !cloud.backup.enabled}
				<p class="section-lead">
					Once a day, an encrypted copy goes to Print Lab Cloud (Family plan), so a broken or lost
					computer does not take your projects with it. It is locked with a recovery key that only
					you hold: we cannot open it, and without the key nobody can.
				</p>
				{#if cloud.plan}
					<button class="secondary" disabled={!!working} onclick={() => cloudAction('enable')}
						>Turn on cloud backup</button
					>
				{:else}
					<p class="hint">Needs the Family plan on {cloud.account}.</p>
				{/if}
			{:else}
				<p class="section-lead">
					{#if cloud.backup.last}
						Encrypted copy sent {stamp(cloud.backup.last.at)} ({size(cloud.backup.last.size)}). The
						next one goes tomorrow.
					{:else}
						On. The first encrypted copy goes within a few minutes.
					{/if}
				</p>
				{#if cloud.backup.error}<p class="bad" role="alert">{cloud.backup.error}</p>{/if}
				<div class="bk-actions">
					<button class="secondary" disabled={!!working} onclick={() => cloudAction('now')}
						>{working === 'cloud-now' ? 'Sending…' : 'Send a copy now'}</button
					>
					<button class="mini" onclick={showKey}>Show recovery key</button>
					<button class="mini" disabled={!!working} onclick={() => cloudAction('disable')}
						>Turn off</button
					>
				</div>
			{/if}

			{#if recoveryKey}
				<div class="bk-key" role="dialog" aria-label="Recovery key">
					<strong>Your recovery key</strong>
					<code>{recoveryKey}</code>
					<p>
						Write it down or save it in a password manager, away from this computer. You need it to
						restore on a new computer. We do not have a copy.
					</p>
					<div class="bk-actions">
						<button class="mini" onclick={copyKey}>Copy</button>
						<button class="mini primary-mini" onclick={() => (recoveryKey = null)}
							>I have saved it</button
						>
					</div>
				</div>
			{/if}

			{#if linked}
				<div class="bk-actions">
					<button class="mini" disabled={!!working} onclick={loadCloud}
						>{working === 'cloud-list' ? 'Looking…' : 'Restore from the cloud…'}</button
					>
				</div>
				{#if cloudList}
					{#if cloudList.length}
						<ol class="bk-list">
							{#each cloudList as b (b.id)}
								<li>
									<span class="bk-when">{stamp(b.createdAt)}</span>
									<span class="bk-why">{b.device}</span>
									<span class="bk-size">{size(b.size)}</span>
									<button
										class="mini"
										disabled={!!working || (keyFor === b.id && !keyInput.trim())}
										onclick={() => restoreCloud(b)}
										aria-label="Restore the cloud backup from {stamp(b.createdAt)}"
										>{working === b.id ? 'Restoring…' : 'Restore'}</button
									>
									{#if keyFor === b.id}
										<label class="bk-keyin"
											>Recovery key for this backup
											<input
												bind:value={keyInput}
												autocomplete="off"
												spellcheck="false"
												placeholder="XXXX-XXXX-…"
											/></label
										>
									{/if}
								</li>
							{/each}
						</ol>
					{:else}
						<p class="panel-empty">No backups in the cloud yet.</p>
					{/if}
				{/if}
			{/if}
		</div>
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
	.bk-cloud {
		margin-top: 18px;
		padding-top: 14px;
		border-top: 1px solid var(--line);
		max-width: 760px;
		display: grid;
		gap: 10px;
	}
	.bk-cloud h3 {
		font-size: 14px;
		margin: 0;
	}
	.bk-cloud .section-lead,
	.bk-cloud .hint {
		margin: 0;
	}
	.bk-cloud .hint {
		font-size: 12.5px;
		color: var(--dim);
	}
	.bk-cloud .bad {
		margin: 0;
		font-size: 12.5px;
		color: var(--amber);
	}
	.bk-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: center;
	}
	.bk-key {
		display: grid;
		gap: 8px;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: rgb(var(--raise));
	}
	.bk-key code {
		font-size: 15px;
		letter-spacing: 0.04em;
		word-break: break-all;
		user-select: all;
	}
	.bk-key p {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.bk-keyin {
		grid-column: 1 / -1;
		display: grid;
		gap: 4px;
		font-size: 12px;
		color: var(--muted);
	}
	.bk-keyin input {
		font-family: var(--mono, monospace);
		letter-spacing: 0.04em;
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
