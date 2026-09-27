<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import type { CameraState } from '$lib/shared/camera';
	import { download } from '$lib/client/actions';
	import type { PrinterStatus } from '$lib/shared/domain';

	// The printer's live camera: the picture (fullscreen, save a snapshot), the timelapse switch, and
	// plain reasons when there is no picture.
	let { printer }: { printer: PrinterStatus } = $props();
	const { lab } = useApp();
	const id = $derived(printer.id ?? '');
	let camera = $state<CameraState | null>(null);
	let watching = $state(true);
	let hidden = $state(false);
	let attempt = $state(0);
	let broken = $state(false);
	let figure = $state<HTMLElement | null>(null);
	let retry: ReturnType<typeof setTimeout> | undefined;
	const s = $derived(printer.state ?? null);
	const src = $derived(
		camera?.available && watching && !hidden
			? `/api/printers/${encodeURIComponent(id)}/camera/stream?n=${attempt}`
			: null
	);

	async function load() {
		if (!id) return;
		const r = await fetch(`/api/printers/${encodeURIComponent(id)}/camera`).catch(() => null);
		if (!r?.ok) {
			camera = null;
			return;
		}
		camera = await r.json();
	}

	// Anything that changes how the camera is reached: ask the server again.
	const reach = $derived(
		`${id}|${printer.connected}|${printer.enabled}|${printer.camera}|${s?.camera.lanLiveview}`
	);
	$effect(() => {
		void reach;
		void load();
	});

	onMount(() => {
		const off = lab.onLive<CameraState>('camera:state', (state) => {
			if (state.printerId === id) camera = state;
		});
		const visibility = () => (hidden = document.hidden);
		document.addEventListener('visibilitychange', visibility);
		return () => {
			off();
			clearTimeout(retry);
			document.removeEventListener('visibilitychange', visibility);
		};
	});

	/** The stream broke off (printer restarted, network): check again, then reconnect. */
	function onError() {
		broken = true;
		clearTimeout(retry);
		retry = setTimeout(async () => {
			await load();
			attempt++;
		}, 3000);
	}

	function fullscreen() {
		if (document.fullscreenElement) void document.exitFullscreen();
		else void figure?.requestFullscreen?.();
	}

	async function setTimelapse(on: boolean) {
		await lab.call(
			'POST',
			`/api/printers/${encodeURIComponent(id)}/commands`,
			{ name: 'camera.ipcam_timelapse', params: { on } },
			on ? 'Timelapses on: the next prints are recorded.' : 'Timelapses off.'
		);
	}
</script>

<section class="panel camera-panel" aria-label="Camera">
	<header class="panel-head">
		<h2>Camera</h2>
		{#if camera?.live && src}<span class="count live-dot">LIVE</span>{/if}
	</header>
	{#if camera?.available}
		<figure class="view" bind:this={figure}>
			{#if src}
				<img
					{src}
					alt="Live view of {printer.name ?? 'the printer'}"
					onload={() => (broken = false)}
					onerror={onError}
				/>
				{#if !camera.live && !broken}<figcaption>{camera.message}</figcaption>{/if}
			{:else}
				<div class="paused">{hidden ? 'Paused while this tab is hidden' : 'Live view paused'}</div>
			{/if}
			{#if camera.reason === 'error'}<figcaption class="err">{camera.message}</figcaption>{/if}
		</figure>
		<div class="camera-actions">
			<button class="mini" onclick={() => (watching = !watching)}
				>{watching ? '❚❚ Pause live view' : '▶ Watch live'}</button
			>
			<button class="mini" onclick={fullscreen} disabled={!src}>⛶ Fullscreen</button>
			<button
				class="mini"
				onclick={() =>
					download(`/api/printers/${encodeURIComponent(id)}/camera/snapshot.jpg?download=1`)}
				>Save a snapshot</button
			>
		</div>
		{#if camera.simulated}
			<p class="note">Simulated printer: the picture is generated, not a real camera.</p>
		{/if}
	{:else if camera}
		<div class="off" data-reason={camera.reason}>
			<strong>Camera off</strong>
			<p>{camera.message}</p>
			{#if camera.reason === 'ffmpeg-missing'}
				<code>sudo apt install ffmpeg</code>
				<a class="mini" href={resolve('/integrations')}>More in Integrations</a>
			{/if}
		</div>
	{:else}
		<p class="panel-empty">Checking the camera…</p>
	{/if}
	{#if printer.connected && printer.caps?.timelapse && s?.camera.timelapse !== null && s?.camera.timelapse !== undefined}
		<label class="timelapse"
			><input
				type="checkbox"
				checked={s.camera.timelapse}
				onchange={(e) => setTimelapse(e.currentTarget.checked)}
			/> Record a timelapse of every print</label
		>
	{/if}
</section>

<style>
	.view {
		position: relative;
		margin: 0 0 10px;
		border-radius: var(--r-md, 10px);
		overflow: hidden;
		background: #000;
		aspect-ratio: 16 / 9;
		display: grid;
		place-items: center;
	}
	.view img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}
	.view:fullscreen {
		border-radius: 0;
		aspect-ratio: auto;
	}
	figcaption {
		position: absolute;
		left: 10px;
		bottom: 10px;
		right: 10px;
		padding: 6px 10px;
		border-radius: 8px;
		background: rgb(0 0 0 / 0.6);
		color: #fff;
		font-size: 12px;
	}
	figcaption.err {
		color: #ffb4a8;
	}
	.paused {
		color: rgb(255 255 255 / 0.7);
		font-size: 13px;
	}
	.camera-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.off {
		display: grid;
		gap: 6px;
		justify-items: start;
		padding: 14px;
		border-radius: var(--r-md, 10px);
		border: 1px dashed var(--line-strong);
		font-size: 13px;
	}
	.off p {
		margin: 0;
		color: var(--muted);
	}
	.off code {
		font-size: 12px;
		padding: 2px 6px;
		border-radius: 6px;
		background: rgb(var(--hi) / 0.06);
		user-select: all;
	}
	.note {
		margin: 8px 0 0;
		font-size: 12px;
		color: var(--dim);
	}
	.timelapse {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
		font-size: 13px;
		color: var(--text-2);
	}
</style>
