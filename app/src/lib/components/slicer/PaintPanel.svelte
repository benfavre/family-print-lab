<script lang="ts">
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { PAINT_CAPABILITY, PAINT_KIND_LABEL, type PaintTool } from '$lib/client/slicer/paint';
	import { filamentCss } from '$lib/client/slicer-3mf';
	import { PAINT_BLOCKER, PAINT_ENFORCER } from '$lib/shared/slicer/paint';

	// The painting tools while painting: brush, fill or smart fill; what to paint; brush size and edge
	// angle. Left drag paints; right drag turns the view.
	let { ws }: { ws: WorkspaceState } = $props();
	const paint = $derived(ws.paint!);
	const objectId = $derived(ws.selection.items[0]?.objectId ?? null);
	const tools: [PaintTool, string, string][] = [
		['brush', 'Brush', 'Paint what the brush touches'],
		['fill', 'Fill', 'Fill the connected area painted alike'],
		['edge', 'Smart fill', 'Fill up to sharp edges']
	];
	const states = $derived.by((): [number, string, string][] => {
		if (paint.kind === 'color')
			return [
				...ws.project.filaments.map((f): [number, string, string] => [
					f.index,
					`${f.index}`,
					filamentCss(f.color) ?? '#888'
				]),
				[0, 'Erase', 'transparent']
			];
		if (paint.kind === 'fuzzySkin')
			return [
				[1, 'Fuzzy', '#d9a13d'],
				[0, 'Erase', 'transparent']
			];
		return [
			[PAINT_ENFORCER, paint.kind === 'seam' ? 'Seam here' : 'Supports here', '#3d8bff'],
			[PAINT_BLOCKER, paint.kind === 'seam' ? 'No seam' : 'No supports', '#ff4d6a'],
			[0, 'Erase', 'transparent']
		];
	});
</script>

{#if ws.paint}
	<section class="panel pp" aria-label="Painting">
		<div class="pp-head">
			<h2 class="panel-title">Paint {PAINT_KIND_LABEL[paint.kind].toLowerCase()}</h2>
			<button class="mini" onclick={() => (ws.paint = null)}>Done</button>
		</div>
		{#if !objectId}<p class="hint">Select the object to paint.</p>{/if}
		{#if !ws.can(PAINT_CAPABILITY[paint.kind])}
			<p class="hint">
				This slicer leaves {PAINT_KIND_LABEL[paint.kind].toLowerCase()} painting out; it is kept in the
				file for Bambu Studio.
			</p>
		{/if}
		<div class="seg" role="radiogroup" aria-label="Tool">
			{#each tools as [t, label, title] (t)}
				<button
					role="radio"
					aria-checked={paint.tool === t}
					class:on={paint.tool === t}
					{title}
					onclick={() => (paint.tool = t)}>{label}</button
				>
			{/each}
		</div>
		<div class="states" role="radiogroup" aria-label="Paint with">
			{#each states as [s, label, colour] (s)}
				<button
					role="radio"
					aria-checked={paint.state === s}
					class:on={paint.state === s}
					onclick={() => (paint.state = s)}
				>
					<i style:--c={colour}></i>{label}
				</button>
			{/each}
		</div>
		{#if paint.tool === 'brush'}
			<label class="slider"
				>Brush <b>{paint.radius} mm</b>
				<input type="range" min="0.5" max="20" step="0.5" bind:value={paint.radius} />
			</label>
		{:else if paint.tool === 'edge'}
			<label class="slider"
				>Edge angle <b>{paint.angle}°</b>
				<input type="range" min="5" max="90" step="5" bind:value={paint.angle} />
			</label>
		{/if}
		<p class="hint">Drag on the object to paint. Right drag turns the view.</p>
		{#if objectId}
			<button class="mini danger-mini" onclick={() => ws.clearPaint(objectId, paint.kind)}
				>Clear this painting</button
			>
		{/if}
	</section>
{/if}

<style>
	.pp {
		display: grid;
		gap: 10px;
	}
	.pp-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.seg,
	.states {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.seg button,
	.states button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 9px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: none;
		color: var(--text);
		font-size: 12.5px;
		cursor: pointer;
	}
	.seg button.on,
	.states button.on {
		border-color: var(--cyan);
		color: var(--cyan);
	}
	.states i {
		width: 12px;
		height: 12px;
		border-radius: 4px;
		background: var(--c);
		box-shadow: inset 0 0 0 1px var(--line-strong);
	}
	.slider {
		display: grid;
		gap: 4px;
		font-size: 12.5px;
	}
</style>
