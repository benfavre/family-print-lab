<script lang="ts">
	import { pickId, type PlateObject } from '$lib/shared/controls';

	// The plate from above (the sliced file's top_<n>.png); a click reads the same spot of the pick image
	// (pick_<n>.png), whose colour is the object's identify_id, and chosen or skipped objects are tinted.
	let {
		printerId,
		version,
		objects,
		picked,
		disabled,
		toggle
	}: {
		printerId: string;
		/** Changes when the print changes, so the pictures are fetched again. */
		version: string;
		objects: PlateObject[];
		picked: number[];
		disabled: boolean;
		toggle: (id: number) => void;
	} = $props();

	let canvas = $state<HTMLCanvasElement>();
	let top = $state<ImageBitmap | null>(null);
	let pick = $state<ImageData | null>(null);
	let failed = $state(false);

	/** Decodes a PNG without colour correction, so the pick colours stay exact. */
	async function bitmap(url: string, signal: AbortSignal) {
		const r = await fetch(url, { signal });
		if (!r.ok) throw new Error('No picture');
		return createImageBitmap(await r.blob(), {
			colorSpaceConversion: 'none',
			premultiplyAlpha: 'none'
		});
	}

	$effect(() => {
		const base = `/api/printers/${printerId}/objects`;
		const k = encodeURIComponent(version);
		const abort = new AbortController();
		Promise.all([
			bitmap(`${base}/top.png?k=${k}`, abort.signal),
			bitmap(`${base}/pick.png?k=${k}`, abort.signal)
		])
			.then(([t, p]) => {
				const c = document.createElement('canvas');
				c.width = p.width;
				c.height = p.height;
				const ctx = c.getContext('2d', { willReadFrequently: true })!;
				ctx.drawImage(p, 0, 0);
				pick = ctx.getImageData(0, 0, p.width, p.height);
				top = t;
				failed = false;
			})
			.catch((error: Error) => {
				if (error.name !== 'AbortError') failed = true;
			});
		return () => abort.abort();
	});

	/** The object under a spot of the pick image, if any. */
	function idAt(x: number, y: number): number | null {
		if (!pick) return null;
		const px = Math.min(pick.width - 1, Math.max(0, Math.floor(x * pick.width)));
		const py = Math.min(pick.height - 1, Math.max(0, Math.floor(y * pick.height)));
		const i = (py * pick.width + px) * 4;
		const d = pick.data;
		return pickId(d[i], d[i + 1], d[i + 2], d[i + 3]);
	}

	// Draw the top view with chosen objects tinted red and skipped ones greyed out.
	$effect(() => {
		if (!canvas || !top || !pick) return;
		const chosen = new Set(picked);
		const skipped = new Set(objects.filter((o) => o.skipped).map((o) => o.id));
		canvas.width = top.width;
		canvas.height = top.height;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(top, 0, 0);
		if (!chosen.size && !skipped.size) return;
		const img = ctx.getImageData(0, 0, top.width, top.height);
		for (let y = 0; y < top.height; y++)
			for (let x = 0; x < top.width; x++) {
				const id = idAt((x + 0.5) / top.width, (y + 0.5) / top.height);
				if (id === null || (!chosen.has(id) && !skipped.has(id))) continue;
				const i = (y * top.width + x) * 4;
				const d = img.data;
				if (chosen.has(id)) {
					d[i] = Math.round(d[i] * 0.4 + 255 * 0.6);
					d[i + 1] = Math.round(d[i + 1] * 0.4 + 60 * 0.6);
					d[i + 2] = Math.round(d[i + 2] * 0.4 + 60 * 0.6);
				} else {
					const grey = Math.round((d[i] + d[i + 1] + d[i + 2]) / 3);
					d[i] = d[i + 1] = d[i + 2] = grey;
					d[i + 3] = Math.round(d[i + 3] * 0.35);
				}
			}
		ctx.putImageData(img, 0, 0);
	});

	function click(e: MouseEvent) {
		if (disabled || !canvas) return;
		const box = canvas.getBoundingClientRect();
		// The picture keeps its proportions inside the box (object-fit: contain).
		const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
		const w = canvas.width * scale;
		const h = canvas.height * scale;
		const x = (e.clientX - box.left - (box.width - w) / 2) / w;
		const y = (e.clientY - box.top - (box.height - h) / 2) / h;
		if (x < 0 || x > 1 || y < 0 || y > 1) return;
		const id = idAt(x, y);
		const o = objects.find((x) => x.id === id);
		if (o && !o.skipped) toggle(o.id);
	}
</script>

{#if failed}
	<p class="panel-empty">The plate picture could not be loaded; choose objects in the list.</p>
{:else}
	<!-- The list next to the map does the same with the keyboard, so the map is left out of it. -->
	<canvas
		bind:this={canvas}
		class="plate-picture"
		class:off={disabled}
		aria-hidden="true"
		onclick={click}
	></canvas>
{/if}

<style>
	.plate-picture {
		width: 100%;
		max-height: 260px;
		object-fit: contain;
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
		cursor: pointer;
	}
	.plate-picture.off {
		cursor: default;
	}
</style>
