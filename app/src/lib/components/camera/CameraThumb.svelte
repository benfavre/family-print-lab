<script lang="ts">
	import { onMount } from 'svelte';
	import { cameraPrefs } from '$lib/client/modules/camera/settings.svelte';
	import type { PrinterStatus } from '$lib/shared/domain';

	// A small camera picture on a printer card, refreshed every 10 s, only when "Show camera on
	// printer cards" is on. Hidden while the printer has no picture to give, trying again every minute
	// (the camera may still be starting, or LAN Only Liveview may be switched on meanwhile).
	let { printer }: { printer: PrinterStatus } = $props();
	const RETRY_TICKS = 6;
	let tick = $state(0);
	let failedAt = $state<number | null>(null);
	let hidden = $state(false);
	const show = $derived(
		cameraPrefs.value.showOnCards &&
			!!printer.id &&
			!!printer.connected &&
			printer.camera !== 'none' &&
			(failedAt === null || tick - failedAt >= RETRY_TICKS)
	);

	onMount(() => {
		void cameraPrefs.load();
		const timer = setInterval(() => {
			if (!document.hidden) tick++;
		}, 10_000);
		const visibility = () => (hidden = document.hidden);
		document.addEventListener('visibilitychange', visibility);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', visibility);
		};
	});

	// A printer that comes back online gets another try at once.
	$effect(() => {
		if (!printer.connected) failedAt = null;
	});
</script>

{#if show && !hidden}
	<img
		class="camera-thumb"
		src="/api/printers/{encodeURIComponent(printer.id ?? '')}/camera/snapshot.jpg?t={tick}"
		alt="Camera of {printer.name ?? 'the printer'}"
		loading="lazy"
		onload={() => (failedAt = null)}
		onerror={() => (failedAt = tick)}
	/>
{/if}

<style>
	.camera-thumb {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		border-radius: var(--r-md, 10px);
		background: #000;
	}
</style>
