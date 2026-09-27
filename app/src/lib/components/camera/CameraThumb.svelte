<script lang="ts">
	import { onMount } from 'svelte';
	import { cameraPrefs } from '$lib/client/modules/camera/settings.svelte';
	import type { PrinterStatus } from '$lib/shared/domain';

	// A small camera picture on a printer card, refreshed every 10 s, only when "Show camera on
	// printer cards" is on. Hidden when the printer has no picture to give.
	let { printer }: { printer: PrinterStatus } = $props();
	let tick = $state(0);
	let failed = $state(false);
	let hidden = $state(false);
	const show = $derived(
		cameraPrefs.value.showOnCards &&
			!!printer.id &&
			!!printer.connected &&
			printer.camera !== 'none' &&
			!failed
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

	// A printer that comes back online gets another try.
	$effect(() => {
		if (!printer.connected) failed = false;
	});
</script>

{#if show && !hidden}
	<img
		class="camera-thumb"
		src="/api/printers/{encodeURIComponent(printer.id ?? '')}/camera/snapshot.jpg?t={tick}"
		alt="Camera of {printer.name ?? 'the printer'}"
		loading="lazy"
		onerror={() => (failed = true)}
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
