<script lang="ts">
	import { download } from '$lib/client/actions';
	import { stamp } from '$lib/client/format';
	import { fileSize, fileUrl } from '$lib/client/modules/camera/settings.svelte';
	import { TIMELAPSE_DIR, type MediaEntry, type MediaListing } from '$lib/shared/camera';

	// Timelapses and other files on a printer's storage: browse folders, watch videos here, download.
	// There is no delete: the printer's file service is only read from.
	let { printerId, connected }: { printerId: string; connected: boolean } = $props();
	let dir = $state(TIMELAPSE_DIR);
	let listing = $state<MediaListing | null>(null);
	let error = $state('');
	let loading = $state(false);
	let playing = $state<string | null>(null);
	let request = 0;

	async function load(path: string) {
		const mine = ++request;
		loading = true;
		error = '';
		playing = null;
		const r = await fetch(
			`/api/printers/${encodeURIComponent(printerId)}/files?${new URLSearchParams({ dir: path })}`
		).catch(() => null);
		if (mine !== request) return;
		loading = false;
		if (!r) return void (error = 'Could not reach the app server. Is it still running?');
		const data = await r.json().catch(() => ({}));
		if (!r.ok) {
			listing = null;
			error = data.error ?? `Could not read the printer’s files (${r.status}).`;
			return;
		}
		listing = data;
	}

	$effect(() => {
		if (connected) void load(dir);
	});

	const crumbs = $derived(
		dir === '/'
			? [{ name: 'Printer storage', path: '/' }]
			: [
					{ name: 'Printer storage', path: '/' },
					...dir
						.split('/')
						.filter(Boolean)
						.map((name, i, all) => ({ name, path: `/${all.slice(0, i + 1).join('/')}` }))
				]
	);
	const icon = (e: MediaEntry) =>
		e.kind === 'dir' ? '📁' : e.kind === 'video' ? '🎞' : e.kind === 'image' ? '🖼' : '📄';
</script>

<div class="media">
	<div class="media-bar">
		<div class="tabs" role="group" aria-label="What to show">
			<button
				class="mini"
				aria-pressed={dir === TIMELAPSE_DIR}
				onclick={() => (dir = TIMELAPSE_DIR)}>Timelapses</button
			>
			<button class="mini" aria-pressed={dir === '/'} onclick={() => (dir = '/')}>All files</button>
		</div>
		<nav class="crumbs" aria-label="Folder">
			{#each crumbs as c, i (c.path)}
				{#if i}<span aria-hidden="true">/</span>{/if}
				<button class="link" disabled={c.path === dir} onclick={() => (dir = c.path)}
					>{c.name}</button
				>
			{/each}
		</nav>
		<button class="mini" disabled={loading || !connected} onclick={() => load(dir)}
			>{loading ? 'Loading…' : 'Refresh'}</button
		>
	</div>

	{#if !connected}
		<p class="panel-empty">The printer is offline. Its files show here when it is back.</p>
	{:else if error}
		<p class="panel-empty err">{error}</p>
	{:else if listing}
		{#if listing.note}<p class="panel-empty">{listing.note}</p>{/if}
		{#if listing.entries.length}
			<ul class="grid">
				{#each listing.entries as e (e.path)}
					<li class="item" class:dir={e.type === 'dir'} data-kind={e.kind}>
						{#if e.type === 'dir'}
							<button class="open" onclick={() => (dir = e.path)}>
								<span class="icon" aria-hidden="true">{icon(e)}</span>
								<span class="name">{e.name}</span>
							</button>
						{:else}
							{#if playing === e.path}
								<!-- svelte-ignore a11y_media_has_caption -->
								<video src={fileUrl(printerId, e.path, true)} controls autoplay></video>
							{:else if e.kind === 'video'}
								<button class="thumb" onclick={() => (playing = e.path)} aria-label="Play {e.name}">
									{#if e.thumbnail}
										<img src={fileUrl(printerId, e.thumbnail, true)} alt="" loading="lazy" />
									{:else}
										<span class="icon" aria-hidden="true">{icon(e)}</span>
									{/if}
									<span class="play" aria-hidden="true">▶</span>
								</button>
							{:else if e.kind === 'image'}
								<div class="thumb">
									<img src={fileUrl(printerId, e.path, true)} alt={e.name} loading="lazy" />
								</div>
							{:else}
								<div class="thumb"><span class="icon" aria-hidden="true">{icon(e)}</span></div>
							{/if}
							<div class="meta">
								<span class="name" title={e.name}>{e.name}</span>
								<small>{fileSize(e.size)}{e.modified ? ` · ${stamp(e.modified)}` : ''}</small>
							</div>
							<button class="mini" onclick={() => download(fileUrl(printerId, e.path))}
								>Download</button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<p class="panel-empty">Reading the printer’s files…</p>
	{/if}
</div>

<style>
	.media-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-bottom: 12px;
	}
	.tabs {
		display: flex;
		gap: 6px;
	}
	.tabs [aria-pressed='true'] {
		border-color: var(--cyan);
		background: rgb(var(--hi) / 0.08);
		color: var(--text);
	}
	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		flex: 1;
		font-size: 13px;
		color: var(--dim);
	}
	.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--cyan);
		cursor: pointer;
		font: inherit;
	}
	.link:disabled {
		color: var(--text-2);
		cursor: default;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.item {
		display: grid;
		gap: 8px;
		align-content: start;
		padding: 10px;
		border-radius: var(--r-lg);
		background: var(--panel);
		border: 1px solid var(--line);
		min-width: 0;
	}
	.item > .mini {
		justify-self: start;
	}
	.open {
		display: flex;
		align-items: center;
		gap: 10px;
		background: none;
		border: none;
		padding: 4px;
		color: inherit;
		cursor: pointer;
		font: inherit;
		text-align: left;
		min-width: 0;
	}
	.thumb {
		position: relative;
		display: grid;
		place-items: center;
		aspect-ratio: 16 / 9;
		width: 100%;
		padding: 0;
		border: none;
		border-radius: var(--r-md, 10px);
		background: rgb(var(--hi) / 0.05);
		overflow: hidden;
		cursor: pointer;
	}
	div.thumb {
		cursor: default;
	}
	.thumb img,
	video {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		border-radius: var(--r-md, 10px);
	}
	video {
		aspect-ratio: 16 / 9;
		background: #000;
		object-fit: contain;
	}
	.play {
		position: absolute;
		width: 38px;
		height: 38px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: rgb(0 0 0 / 0.55);
		color: #fff;
		font-size: 15px;
	}
	.icon {
		font-size: 26px;
	}
	.meta {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.name {
		font-size: 13px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta small {
		font-size: 11px;
		color: var(--dim);
	}
	.err {
		color: var(--err-text);
	}
</style>
