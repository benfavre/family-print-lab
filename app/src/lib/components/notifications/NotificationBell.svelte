<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import type { NotificationItem, NotificationList, NotifyLevel } from '$lib/shared/notifications';

	// The bell in the top bar: unread count, the latest notifications, mark read, open what they are
	// about. Kept up to date by the notifications:changed live channel.
	const { lab } = useApp();
	let open = $state(false);
	let root = $state<HTMLDivElement>();
	let items = $state<NotificationItem[]>([]);
	let unread = $state(0);
	let failed = $state(false);
	let now = $state(Date.now());

	const GLYPH: Record<NotifyLevel, string> = { success: '✓', error: '✕', warning: '!', info: 'i' };

	async function load() {
		try {
			const r = await fetch('/api/notifications?limit=50');
			if (!r.ok) throw new Error();
			const data: NotificationList = await r.json();
			items = data.items;
			unread = data.unread;
			failed = false;
		} catch {
			failed = true;
		}
	}

	async function post(path: string, method: string, body?: unknown) {
		try {
			const r = await fetch(path, {
				method,
				headers: body === undefined ? undefined : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			if (r.ok) unread = ((await r.json()) as NotificationList).unread;
		} catch {
			/* the live channel or the next load catches up */
		}
	}

	function markAll() {
		const at = new Date().toISOString();
		items = items.map((n) => (n.readAt ? n : { ...n, readAt: at }));
		void post('/api/notifications/read', 'POST', { all: true });
	}
	function clearAll() {
		items = [];
		void post('/api/notifications', 'DELETE');
	}
	async function openItem(n: NotificationItem) {
		if (!n.readAt) {
			items = items.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x));
			void post('/api/notifications/read', 'POST', { ids: [n.id] });
		}
		if (n.link) {
			open = false;
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- server-made in-app paths
			await goto(n.link);
		}
	}

	const ago = (iso: string) => {
		const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
		if (s < 60) return 'just now';
		if (s < 3600) return `${Math.floor(s / 60)} min ago`;
		if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	};

	onMount(() => {
		void load();
		const off = lab.onLive<{ unread: number; item?: NotificationItem }>(
			'notifications:changed',
			(d) => {
				unread = d.unread;
				if (d.item) items = [d.item, ...items.filter((n) => n.id !== d.item!.id)].slice(0, 50);
			}
		);
		return off;
	});
	$effect(() => {
		if (!open) return;
		now = Date.now();
		void load();
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	function outside(e: MouseEvent) {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onclick={outside} onkeydown={(e) => e.key === 'Escape' && open && (open = false)} />

<div class="bell" bind:this={root}>
	<button
		type="button"
		class="icon-button bell-button"
		aria-expanded={open}
		aria-haspopup="true"
		aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
		title="Notifications"
		onclick={() => (open = !open)}
	>
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
			><path
				d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1.2 1.3H2.8zM6.5 14a1.6 1.6 0 0 0 3 0"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linejoin="round"
				stroke-linecap="round"
			/></svg
		>
		{#if unread}<b class="count" data-testid="unread">{unread > 99 ? '99+' : unread}</b>{/if}
	</button>

	{#if open}
		<div class="tray" role="region" aria-label="Latest notifications">
			<div class="tray-head">
				<strong>Notifications</strong>
				<span class="sub">{unread ? `${unread} unread` : 'All read'}</span>
				{#if unread}<button type="button" class="mini" onclick={markAll}>Mark all read</button>{/if}
			</div>
			{#if failed}
				<p class="empty">Could not load notifications.</p>
			{:else if !items.length}
				<p class="empty">
					Nothing yet. Finished and failed prints, printer alerts and kids' requests show up here.
				</p>
			{:else}
				<ol>
					{#each items as n (n.id)}
						<li class="note l-{n.level}" class:unread={!n.readAt}>
							<button type="button" class="note-button" onclick={() => openItem(n)}>
								<span class="glyph" aria-hidden="true">{GLYPH[n.level]}</span>
								<span class="note-body">
									<span class="note-top"
										><strong>{n.title}</strong><span class="time">{ago(n.createdAt)}</span></span
									>
									{#if n.body}<span class="text">{n.body}</span>{/if}
									{#if n.printerId && lab.printerById(n.printerId)?.name}<span class="meta"
											>{lab.printerById(n.printerId)?.name}</span
										>{/if}
								</span>
								{#if !n.readAt}<span class="dot" aria-label="Unread"></span>{/if}
							</button>
						</li>
					{/each}
				</ol>
			{/if}
			<div class="tray-foot">
				<a
					class="mini"
					href="{resolve('/integrations')}#notifications"
					onclick={() => (open = false)}>Notification settings</a
				>
				{#if items.length}<button type="button" class="mini" onclick={clearAll}>Clear all</button
					>{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.bell {
		position: relative;
	}
	.bell-button {
		position: relative;
	}
	.count {
		position: absolute;
		top: -3px;
		right: -5px;
		min-width: 17px;
		height: 17px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--red);
		color: #fff;
		font: 700 10.5px/17px var(--mono);
		text-align: center;
	}
	.tray {
		position: absolute;
		right: 0;
		top: calc(100% + 8px);
		z-index: 50;
		width: min(400px, calc(100vw - 24px));
		max-height: min(560px, 75vh);
		overflow-y: auto;
		border-radius: var(--r-lg);
		border: 1px solid var(--line-strong);
		background: var(--menu);
		box-shadow: 0 24px 60px rgb(var(--lo) / 0.45);
		padding: 12px;
		scrollbar-width: thin;
	}
	.tray-head,
	.tray-foot {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.tray-head {
		margin-bottom: 8px;
	}
	.tray-foot {
		margin-top: 10px;
		justify-content: space-between;
	}
	.tray-foot a.mini {
		text-decoration: none;
	}
	.tray-head strong {
		font-size: 14px;
	}
	.sub {
		flex: 1;
		font-size: 12px;
		color: var(--dim);
	}
	.empty {
		margin: 6px 0;
		font-size: 13px;
		color: var(--muted);
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.note-button {
		display: flex;
		gap: 10px;
		width: 100%;
		padding: 9px 10px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: rgb(var(--hi) / 0.02);
		color: var(--text);
		text-align: left;
		font: inherit;
		cursor: pointer;
	}
	.note-button:hover {
		background: rgb(var(--hi) / 0.06);
	}
	.unread .note-button {
		border-color: var(--line-strong);
		background: rgb(var(--hi) / 0.05);
	}
	.glyph {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font: 700 11px var(--mono);
		color: var(--c2-text);
		background: rgb(var(--c2) / 0.18);
	}
	.l-success .glyph {
		color: var(--lime);
		background: rgb(var(--c3) / 0.18);
	}
	.l-error .glyph {
		color: var(--err-text);
		background: rgb(var(--c5) / 0.16);
	}
	.l-warning .glyph {
		color: var(--amber);
		background: rgb(var(--c4) / 0.18);
	}
	.note-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.note-top {
		display: flex;
		gap: 8px;
		align-items: baseline;
	}
	.note-top strong {
		flex: 1;
		min-width: 0;
		font-size: 13px;
		font-weight: 550;
		overflow-wrap: anywhere;
	}
	.time {
		font-size: 11.5px;
		color: var(--dim);
		white-space: nowrap;
	}
	.text {
		font-size: 12.5px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.meta {
		font-size: 11.5px;
		color: var(--dim);
	}
	@media (max-width: 700px) {
		.tray {
			position: fixed;
			left: 12px;
			right: 12px;
			top: 58px;
			width: auto;
		}
	}
	.dot {
		width: 8px;
		height: 8px;
		margin-top: 5px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--cyan);
	}
</style>
