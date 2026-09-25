<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';

	const { lab } = useApp();
	const states: Record<string, string> = {
		IDLE: 'Idle',
		PREPARE: 'Preparing',
		RUNNING: 'Printing',
		PAUSE: 'Paused',
		FINISH: 'Finished',
		FAILED: 'Failed',
		SLICING: 'Slicing',
		UNKNOWN: 'Waiting for data'
	};
	const p = $derived(lab.printer);
	const label = $derived(
		!p.configured
			? 'not connected'
			: !p.connected
				? 'offline'
				: !p.state
					? 'connecting'
					: `${states[p.state.gcodeState] ?? p.state.gcodeState}${lab.printerActive && p.state.percent !== null ? ` ${p.state.percent}%` : ''}`
	);
	const dot = $derived(!p.configured || !p.connected ? 'off' : lab.printerActive ? 'live' : 'idle');
</script>

<a class="printer-chip" href={resolve('/printer')}>
	<span class="pulse {dot}" aria-hidden="true"></span>{p.name ?? 'Bambu Lab X2D'}
	{#if p.simulated}<span class="sim-badge">Simulator</span>{/if}
	<em>· {label}</em>
</a>
