<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { stamp } from '$lib/client/format';
	import { printerAlerts } from '$lib/client/modules/hms/data';
	import HmsAlert from '$lib/components/hms/HmsAlert.svelte';
	import {
		SEVERITY_LABELS,
		displayCode,
		type HmsAlert as Alert,
		type HmsEventRow,
		type HmsSeverity
	} from '$lib/shared/hms';

	// One printer's alerts: the active ones with Bambu's buttons, the history of raised and cleared
	// alerts (filter by severity), and a box to look any code up.
	const { lab } = useApp();
	const id = $derived(page.params.id ?? '');
	const printer = $derived(lab.printerById(id));
	const PAGE = 50;
	const FILTERS: [string, string, HmsSeverity[]][] = [
		['all', 'All', []],
		['serious', 'Fatal and serious', ['fatal', 'serious']],
		['common', 'Warnings', ['common']],
		['info', 'Info', ['info']]
	];
	let filter = $state('all');
	let active = $state<Alert[]>([]);
	let rows = $state<HmsEventRow[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let failed = $state(false);

	let request = 0;
	async function load(more = false) {
		if (!id) return;
		const mine = ++request;
		const severity = FILTERS.find((f) => f[0] === filter)?.[2] ?? [];
		const view = await printerAlerts(id, { severity, limit: PAGE, offset: more ? rows.length : 0 });
		if (mine !== request) return;
		loading = false;
		failed = !view;
		if (!view) return;
		active = view.active;
		rows = more ? [...rows, ...view.history] : view.history;
		total = view.total;
	}
	$effect(() => {
		void filter;
		void id;
		void load();
	});
	$effect(() =>
		lab.onLive<{ printerId: string }>('hms:changed', (d) => {
			if (d.printerId === id) void load();
		})
	);

	let code = $state('');
	let found = $state<Alert | null>(null);
	let lookupError = $state('');
	async function lookup(e: SubmitEvent) {
		e.preventDefault();
		lookupError = '';
		found = null;
		const q = new URLSearchParams({ code: code.trim(), printerId: id });
		const res = await fetch(`/api/hms/lookup?${q}`).catch(() => null);
		const data = await res?.json().catch(() => ({}));
		if (res?.ok) found = data as Alert;
		else lookupError = data?.error ?? 'Could not look that code up.';
	}
	const jobTitle = (jobId: string | null) => {
		const job = jobId ? lab.ws.jobs.find((j) => j.id === jobId) : undefined;
		return job ? (lab.project(job.projectId)?.title ?? 'a job') : null;
	};
</script>

<svelte:head><title>Alerts · {printer?.name ?? 'Printer'} · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		<div class="section-meta">
			<a href={resolve('/printers/[id]', { id })}>← {printer?.name ?? 'Printer'}</a>
			<span>Texts from Bambu Lab, kept on this computer</span>
		</div>
		{#if failed}
			<p class="error">
				{printer
					? 'Couldn’t load the alerts. Check Printer error help on the Integrations page.'
					: 'That printer no longer exists.'}
			</p>
		{/if}
		<section class="panel">
			<header class="panel-head">
				<h2>Active alerts</h2>
				{#if active.length}<span class="count">{active.length}</span>{/if}
			</header>
			{#if active.length}
				<div class="hms-list">
					{#each active as a (a.key)}<HmsAlert
							alert={a}
							printerId={printer?.connected ? id : null}
							ondone={() => load()}
						/>{/each}
				</div>
			{:else if !loading && !failed}
				<p class="panel-empty">
					{printer?.connected
						? 'No errors reported.'
						: 'The printer is offline; alerts show when it reports again.'}
				</p>
			{/if}
		</section>

		<section class="panel">
			<header class="panel-head">
				<h2>History</h2>
				<span class="count">{total}</span>
			</header>
			<div class="status-tabs" role="group" aria-label="Severity">
				{#each FILTERS as [key, label] (key)}
					<button
						class="status-tab"
						class:selected={filter === key}
						aria-pressed={filter === key}
						onclick={() => (filter = key)}>{label}</button
					>
				{/each}
			</div>
			{#if rows.length}
				<ul class="history">
					{#each rows as r (r.id)}
						<li class="sev-{r.severity}">
							<span class="sev"
								><span class="dot" aria-hidden="true"></span>{SEVERITY_LABELS[r.severity]}</span
							>
							<span class="what">
								{r.text || 'No description for this code yet.'}
								<code>{displayCode(r.code)}</code>
							</span>
							<span class="when">
								{stamp(r.raisedAt)} → {r.clearedAt ? stamp(r.clearedAt) : 'still active'}
								{#if jobTitle(r.jobId)}&nbsp;· during “{jobTitle(r.jobId)}”{/if}
							</span>
						</li>
					{/each}
				</ul>
				{#if rows.length < total}
					<button class="mini" onclick={() => load(true)}>Show older alerts</button>
				{/if}
			{:else if !loading && !failed}
				<p class="panel-empty">
					Nothing yet. Alerts the printer raises while the app is running are kept here.
				</p>
			{/if}
		</section>

		<section class="panel">
			<h2 class="panel-title">Look up a code</h2>
			<form class="lookup" onsubmit={lookup}>
				<input
					bind:value={code}
					placeholder="0700_2000_0002_0001 or 0700_8011"
					aria-label="Error code"
					maxlength="40"
				/>
				<button class="mini primary-mini" disabled={!code.trim()}>Look up</button>
			</form>
			{#if lookupError}<p class="error">{lookupError}</p>{/if}
			{#if found}<HmsAlert alert={{ ...found, actions: [] }} printerId={null} />{/if}
		</section>
	</div>
</div>

<style>
	.hms-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.status-tabs {
		margin-bottom: 10px;
		width: fit-content;
		max-width: 100%;
	}
	.history {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.history li {
		--sev: var(--muted);
		display: grid;
		grid-template-columns: 120px 1fr;
		gap: 2px 12px;
		padding: 8px 0;
		border-top: 1px solid var(--line);
		font-size: 13px;
	}
	.history li:first-child {
		border-top: 0;
	}
	.sev-fatal,
	.sev-serious {
		--sev: var(--red) !important;
	}
	.sev-common {
		--sev: var(--amber) !important;
	}
	.sev-info {
		--sev: var(--blue) !important;
	}
	.sev {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		color: var(--sev);
		grid-row: span 2;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--sev);
	}
	.what {
		color: var(--text);
	}
	.when {
		color: var(--muted);
		font-size: 12px;
	}
	.lookup {
		display: flex;
		gap: 8px;
		margin-bottom: 10px;
	}
	.lookup input {
		flex: 1;
		min-width: 0;
		font-family: var(--mono);
	}
	@media (max-width: 640px) {
		.history li {
			grid-template-columns: 1fr;
		}
		.sev {
			grid-row: auto;
		}
	}
</style>
