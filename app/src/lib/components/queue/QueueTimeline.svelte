<script lang="ts">
	import { onMount } from 'svelte';
	import { duration } from '$lib/client/format';
	import { open } from '$lib/client/modules/queue/actions';
	import { planTimeline, quietSpans, type QueueView } from '$lib/shared/queue';

	// When each queued job would print, if everything went to plan: one lane per printer, the running
	// print first, quiet hours shaded, a line for now. Estimates come from the sliced files.
	let { view }: { view: QueueView } = $props();
	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	const W = 1000;
	const LEFT = 130;
	const LANE = 34;
	const TOP = 22;
	const plan = $derived(
		planTimeline({
			now,
			quiet: view.settings.quietHours,
			printers: view.printers.map((p) => ({
				id: p.printerId,
				model: p.model,
				busyUntil: p.busyUntil ? Date.parse(p.busyUntil) : null
			})),
			items: open(view)
				.filter((i) => i.status === 'waiting' || i.status === 'dispatching')
				.map((i) => ({
					id: i.id,
					printerId: i.printerId,
					minutes: i.minutes,
					notBefore: i.notBefore ? Date.parse(i.notBefore) : null,
					slicedFor: i.slicedFor
				}))
		})
	);
	// At least 12 hours, at most 3 days.
	const end = $derived(
		Math.min(
			now + 72 * 3600_000,
			Math.max(now + 12 * 3600_000, ...plan.blocks.map((b) => b.end + 3600_000))
		)
	);
	const x = (t: number) => LEFT + ((t - now) / (end - now)) * (W - LEFT - 8);
	const height = $derived(TOP + view.printers.length * LANE + 6);
	const lane = (id: string) => view.printers.findIndex((p) => p.printerId === id);
	const hours = $derived.by(() => {
		const step = end - now > 36 * 3600_000 ? 6 : end - now > 18 * 3600_000 ? 3 : 2;
		const d = new Date(now);
		const first = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
		const out: number[] = [];
		for (let t = first + 3600_000; t < end; t += 3600_000)
			if (new Date(t).getHours() % step === 0) out.push(t);
		return out;
	});
	const spans = $derived(quietSpans(new Date(now), new Date(end), view.settings.quietHours));
	const title = (id: string | null) =>
		id ? (view.items.find((i) => i.id === id)?.title ?? '') : 'Printing now';
	const hm = (t: number) =>
		new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
</script>

<figure class="timeline">
	<svg viewBox="0 0 {W} {height}" role="img" aria-label="Queue timeline">
		{#each spans as s (s.start.getTime())}
			<rect
				class="quiet"
				x={x(s.start.getTime())}
				y={TOP - 4}
				width={Math.max(1, x(s.end.getTime()) - x(s.start.getTime()))}
				height={height - TOP}
				><title>Quiet hours {hm(s.start.getTime())}–{hm(s.end.getTime())}</title></rect
			>
		{/each}
		{#each hours as t (t)}
			<line class="tick" x1={x(t)} x2={x(t)} y1={TOP - 4} y2={height} />
			<text class="hour" x={x(t)} y={12} text-anchor="middle"
				>{new Date(t).getHours() === 0
					? new Date(t).toLocaleDateString('en-GB', { weekday: 'short' })
					: hm(t)}</text
			>
		{/each}
		{#each view.printers as p, i (p.printerId)}
			<text class="lane-name" x={0} y={TOP + i * LANE + LANE / 2 + 4}>{p.name}</text>
		{/each}
		{#each plan.blocks as b (`${b.printerId}-${b.itemId}`)}
			{@const y = TOP + lane(b.printerId) * LANE + 4}
			{@const w = Math.max(3, x(b.end) - x(b.start))}
			<g class="block" class:now={!b.itemId} class:guessed={b.guessed}>
				<rect x={x(b.start)} {y} width={w} height={LANE - 8} rx="5" />
				{#if w > 60}
					<text x={x(b.start) + 6} y={y + (LANE - 8) / 2 + 4}
						>{title(b.itemId).slice(0, Math.floor(w / 7))}</text
					>
				{/if}
				<title
					>{title(b.itemId)} · {hm(b.start)}–{hm(b.end)} ({duration(
						(b.end - b.start) / 60_000
					)}{b.guessed ? ', no estimate in the file' : ''})</title
				>
			</g>
		{/each}
		<line class="now-line" x1={x(now)} x2={x(now)} y1={TOP - 6} y2={height} />
	</svg>
	<figcaption>
		Estimates from the sliced files; waiting for someone to clear the plate is not included.
		{#if plan.unplaced.length}{plan.unplaced.length} queued {plan.unplaced.length === 1
				? 'job fits'
				: 'jobs fit'} no printer.{/if}
	</figcaption>
</figure>

<style>
	.timeline {
		margin: 0;
	}
	svg {
		width: 100%;
		height: auto;
		display: block;
	}
	.quiet {
		fill: rgb(var(--hi) / 0.05);
	}
	.tick {
		stroke: var(--line);
	}
	.hour,
	.lane-name {
		fill: var(--muted);
		font-size: 11px;
	}
	.lane-name {
		font-size: 12px;
	}
	.block rect {
		fill: color-mix(in srgb, var(--cyan) 30%, transparent);
		stroke: var(--cyan);
	}
	.block.now rect {
		fill: color-mix(in srgb, var(--amber) 30%, transparent);
		stroke: var(--amber);
	}
	.block.guessed rect {
		stroke-dasharray: 4 3;
	}
	.block text {
		fill: var(--text);
		font-size: 11px;
		pointer-events: none;
	}
	.now-line {
		stroke: var(--red);
		stroke-width: 1.5;
	}
	figcaption {
		margin-top: 6px;
		font-size: 12px;
		color: var(--dim);
	}
</style>
