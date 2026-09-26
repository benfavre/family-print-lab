<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { printerStateLabel } from '$lib/client/format';
	import type { PrinterStatus } from '$lib/shared/domain';

	// The first printer's state; with more printers, a count and a menu listing each one.
	const { lab, ui } = useApp();
	const p = $derived(lab.printer);
	const list = $derived(lab.printerList);
	const short = (x: PrinterStatus) => {
		const label = printerStateLabel(x).toLowerCase();
		const active = !!x.id && lab.printerActiveFor(x.id);
		return `${label}${active && x.state?.percent !== null && x.state?.percent !== undefined ? ` ${x.state.percent}%` : ''}`;
	};
	const dot = (x: PrinterStatus) =>
		!x.configured || !x.connected ? 'off' : x.id && lab.printerActiveFor(x.id) ? 'live' : 'idle';
	const href = $derived(p.id ? resolve('/printers/[id]', { id: p.id }) : resolve('/printers'));

	function menu(e: MouseEvent) {
		if (list.length < 2) return;
		e.preventDefault();
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		ui.menu = {
			title: 'Printers',
			items: list.map((x) => ({
				label: `${x.name} · ${short(x)}`,
				href: resolve('/printers/[id]', { id: x.id ?? '' })
			})),
			x: r.left,
			y: r.bottom + 4,
			returnTo: e.currentTarget as HTMLElement
		};
	}
</script>

<a class="printer-chip" {href} onclick={menu} aria-haspopup={list.length > 1 ? 'menu' : undefined}>
	<span class="pulse {dot(p)}" aria-hidden="true"></span>{p.name ?? 'No printer yet'}
	{#if p.simulated}<span class="sim-badge">Simulator</span>{/if}
	<em>· {p.configured ? short(p) : 'not connected'}</em>
	{#if list.length > 1}<span class="more" title="{list.length} printers">+{list.length - 1}</span
		>{/if}
</a>

<style>
	.more {
		padding: 0 6px;
		border-radius: 999px;
		font-size: 11px;
		background: rgb(var(--hi) / 0.08);
		color: var(--muted);
	}
</style>
