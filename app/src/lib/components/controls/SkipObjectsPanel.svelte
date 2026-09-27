<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { controlTarget, runCommand } from '$lib/client/modules/controls/commands';
	import { offlineReason, skipReason, type PlateObjects } from '$lib/shared/controls';
	import type { PrinterStatus } from '$lib/shared/domain';

	// Skip objects on the plate being printed, like Bambu Handy: pick them in the list or on the plate
	// map (drawn from the sliced file's first-layer boxes). Prints sent from elsewhere only show what the
	// printer says is skipped already.
	let { printer }: { printer: PrinterStatus } = $props();
	const app = useApp();
	const t = $derived(controlTarget(printer));
	const s = $derived(printer.state ?? null);
	const reason = $derived(offlineReason(printer) ?? skipReason(t));
	let data = $state<PlateObjects | null>(null);
	let picked = $state<number[]>([]);
	let busy = $state(false);
	/** Refetch when the print or its skipped list changes. */
	const key = $derived(`${printer.id}|${s?.task}|${s?.skippedObjects.join(',')}`);

	$effect(() => {
		void key;
		const abort = new AbortController();
		fetch(`/api/printers/${printer.id}/objects`, { signal: abort.signal })
			.then((r) => (r.ok ? r.json() : null))
			.then((d: PlateObjects | null) => {
				data = d;
				picked = picked.filter((id) => d?.objects.some((o) => o.id === id && !o.skipped));
			})
			.catch(() => {
				/* superseded or offline; the next change asks again */
			});
		return () => abort.abort();
	});

	const toggle = (id: number) =>
		(picked = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
	const left = $derived(data?.objects.filter((o) => !o.skipped) ?? []);

	async function skip() {
		const names = data!.objects.filter((o) => picked.includes(o.id)).map((o) => o.name);
		const all = picked.length >= left.length;
		if (
			!(await app.ui.ask(
				`Skip ${picked.length === 1 ? `“${names[0]}”` : `${picked.length} objects`}?`,
				all
					? 'That is every object left on the plate; stop the print instead if nothing should finish.'
					: 'The printer stops printing them for the rest of this print. This cannot be undone.',
				'Skip'
			))
		)
			return;
		busy = true;
		try {
			if (await runCommand(app, printer, 'print.skip_objects', { ids: picked }, 'Skipping…'))
				picked = [];
		} finally {
			busy = false;
		}
	}

	// Plate map: bed millimetres with y pointing up, as the boxes are.
	const map = $derived.by(() => {
		const all = data?.bboxAll;
		const boxes = data?.objects.filter((o) => o.bbox) ?? [];
		if (!all || !boxes.length) return null;
		const pad = 6;
		const [x0, y0, x1, y1] = all;
		return {
			viewBox: `${x0 - pad} ${-(y1 + pad)} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`,
			boxes
		};
	});
</script>

<section class="panel">
	<header class="panel-head">
		<h2>Skip objects</h2>
		{#if data?.objects.length}<span class="count">{left.length} of {data.objects.length} left</span
			>{/if}
	</header>
	{#if !data}
		<p class="panel-empty">Looking for the objects on the plate…</p>
	{:else if data.source === 'report'}
		<p class="panel-empty">
			This print was not sent from Family Print Lab, so the objects on its plate are not known here.
			Skip them on the printer's screen or in Bambu Studio.{#if data.skipped.length}
				Skipped so far: {data.skipped.length}.{/if}
		</p>
	{:else if !data.objects.length}
		<p class="panel-empty">The sliced file does not list the objects on this plate.</p>
	{:else}
		<div class="skip">
			{#if map}
				<svg
					class="plate-map"
					viewBox={map.viewBox}
					role="group"
					aria-label="Plate map: choose objects to skip"
				>
					{#each map.boxes as o (o.id)}
						{@const [bx0, by0, bx1, by1] = o.bbox!}
						<rect
							x={bx0}
							y={-by1}
							width={Math.max(1, bx1 - bx0)}
							height={Math.max(1, by1 - by0)}
							rx="1.5"
							class:skipped={o.skipped}
							class:picked={picked.includes(o.id)}
							role="checkbox"
							aria-checked={picked.includes(o.id)}
							aria-label={o.name}
							aria-disabled={o.skipped || !!reason}
							tabindex={o.skipped || reason ? -1 : 0}
							onclick={() => !o.skipped && !reason && toggle(o.id)}
							onkeydown={(e) => {
								if ((e.key === ' ' || e.key === 'Enter') && !o.skipped && !reason) {
									e.preventDefault();
									toggle(o.id);
								}
							}}><title>{o.name}</title></rect
						>
					{/each}
				</svg>
			{:else if data.picture}
				<img
					class="plate-picture"
					src="/api/printers/{printer.id}/objects/plate.png?k={encodeURIComponent(s?.task ?? '')}"
					alt="The plate as sliced"
				/>
			{/if}
			<ul class="objects">
				{#each data.objects as o (o.id)}
					<li class:skipped={o.skipped}>
						<label
							><input
								type="checkbox"
								checked={o.skipped || picked.includes(o.id)}
								disabled={o.skipped || !!reason}
								onchange={() => toggle(o.id)}
							/>
							<span>{o.name}</span>{#if o.skipped}<small>skipped</small>{/if}</label
						>
					</li>
				{/each}
			</ul>
		</div>
		<div class="actions">
			<button
				class="mini danger-mini"
				disabled={!picked.length || !!reason || busy}
				title={reason ?? undefined}
				onclick={skip}>Skip {picked.length || ''} selected</button
			>
			{#if reason}<small class="why">{reason}</small>{/if}
		</div>
	{/if}
</section>

<style>
	.skip {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 12px;
		align-items: start;
	}
	@media (max-width: 640px) {
		.skip {
			grid-template-columns: 1fr;
		}
	}
	.plate-map,
	.plate-picture {
		width: 100%;
		max-height: 260px;
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
	}
	.plate-picture {
		object-fit: contain;
	}
	.plate-map rect {
		fill: rgb(var(--c1) / 0.25);
		stroke: var(--cyan);
		stroke-width: 0.8;
		cursor: pointer;
	}
	.plate-map rect.picked {
		fill: rgb(255 80 80 / 0.35);
		stroke: var(--red);
	}
	.plate-map rect.skipped {
		fill: transparent;
		stroke: var(--muted);
		stroke-dasharray: 2 2;
		cursor: default;
	}
	.objects {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 260px;
		overflow: auto;
	}
	.objects label {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		font-size: 13px;
	}
	.objects li.skipped span {
		text-decoration: line-through;
		color: var(--muted);
	}
	.objects small {
		color: var(--muted);
	}
	.actions {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-top: 10px;
	}
	.why {
		color: var(--muted);
		font-size: 12px;
	}
</style>
