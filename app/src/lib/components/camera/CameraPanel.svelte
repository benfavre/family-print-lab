<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import type { CameraState } from '$lib/shared/camera';
	import type { PrinterStatus } from '$lib/shared/domain';

	// The printer's live camera: the picture (fullscreen, save a snapshot), the timelapse and
	// recording switches, and plain reasons when there is no picture.
	let { printer }: { printer: PrinterStatus } = $props();
	const { lab, ui } = useApp();
	const id = $derived(printer.id ?? '');
	let camera = $state<CameraState | null>(null);
	/** Why the camera state could not be read (app server gone, camera support not running). */
	let failure = $state<string | null>(null);
	let watching = $state(true);
	let hidden = $state(false);
	let attempt = $state(0);
	let broken = $state(false);
	let figure = $state<HTMLElement | null>(null);
	let saving = $state(false);
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
			const data = r ? await r.json().catch(() => ({})) : {};
			failure = data.error ?? 'Could not reach the app server. Is it still running?';
			return;
		}
		failure = null;
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

	/** Saves the newest picture as a file, or says why there is none. */
	async function saveSnapshot() {
		saving = true;
		try {
			const r = await fetch(
				`/api/printers/${encodeURIComponent(id)}/camera/snapshot.jpg?download=1`
			).catch(() => null);
			if (!r) return ui.toast('Could not reach the app server. Is it still running?', 'error');
			if (!r.ok) {
				const data = await r.json().catch(() => ({}));
				return ui.toast(data.error ?? `No picture from the camera (${r.status}).`, 'error');
			}
			const name =
				/filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ??
				'snapshot.jpg';
			const url = URL.createObjectURL(await r.blob());
			const link = document.createElement('a');
			link.href = url;
			link.download = name;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} finally {
			saving = false;
		}
	}

	/** A camera switch on the printer; the box goes back when the printer did not take it. */
	async function setSwitch(
		input: HTMLInputElement,
		name: 'camera.ipcam_timelapse' | 'camera.ipcam_record_set',
		done: string
	) {
		const on = input.checked;
		const ok = await lab.call(
			'POST',
			`/api/printers/${encodeURIComponent(id)}/commands`,
			{ name, params: { on } },
			done
		);
		if (!ok) input.checked = !on;
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
				{#if !camera.live && !broken && camera.reason !== 'error'}<figcaption>
						{camera.message}
					</figcaption>{/if}
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
			<button class="mini" onclick={saveSnapshot} disabled={saving}
				>{saving ? 'Saving…' : 'Save a snapshot'}</button
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
		<p class="panel-empty">{failure ?? 'Checking the camera…'}</p>
	{/if}
	{#if printer.connected && printer.caps?.timelapse && typeof s?.camera.timelapse === 'boolean'}
		<label class="switch"
			><input
				type="checkbox"
				checked={s.camera.timelapse}
				onchange={(e) =>
					setSwitch(
						e.currentTarget,
						'camera.ipcam_timelapse',
						e.currentTarget.checked
							? 'Timelapses on: the next prints are recorded.'
							: 'Timelapses off.'
					)}
			/> Record a timelapse of every print</label
		>
	{/if}
	<!-- Bambu Studio's "Auto-record Monitoring" (CameraPopup.cpp), shown when the printer reports it. -->
	{#if printer.connected && s?.camera.present !== false && typeof s?.camera.recording === 'boolean'}
		<label class="switch"
			><input
				type="checkbox"
				checked={s.camera.recording}
				onchange={(e) =>
					setSwitch(
						e.currentTarget,
						'camera.ipcam_record_set',
						e.currentTarget.checked ? 'Camera recording on.' : 'Camera recording off.'
					)}
			/> Record the camera during prints</label
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
	.switch {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
		font-size: 13px;
		color: var(--text-2);
	}
</style>
