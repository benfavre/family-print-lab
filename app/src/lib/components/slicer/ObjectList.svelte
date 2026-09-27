<script lang="ts">
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { clickPick, pickPart } from '$lib/client/slicer/selection';
	import { objectFilament, partFilament } from '$lib/client/slicer/edit';
	import { PAINT_KIND_LABEL, paintCounts, type PaintKind } from '$lib/client/slicer/paint';
	import { PART_TYPE_LABEL, filamentCss } from '$lib/client/slicer-3mf';

	// The objects on the active plate with their parts, like Bambu Studio's object list.
	let { ws }: { ws: WorkspaceState } = $props();
	const project = $derived(ws.project);
	const plate = $derived(project.plates.find((p) => p.index === ws.plate));
	const rows = $derived.by(() => {
		const seen: string[] = [];
		for (const ref of plate?.instances ?? [])
			if (!seen.includes(ref.objectId)) seen.push(ref.objectId);
		return seen
			.map((id) => project.objects.find((o) => o.id === id))
			.filter((o): o is NonNullable<typeof o> => !!o)
			.map((o) => ({
				obj: o,
				instance: plate!.instances.find((i) => i.objectId === o.id)!.instanceId,
				copies: plate!.instances.filter((i) => i.objectId === o.id).length
			}));
	});
	const colour = (n: number) =>
		filamentCss(project.filaments.find((f) => f.index === n)?.color ?? '') ?? '#888';
	const selected = (id: string) => ws.selection.items.some((i) => i.objectId === id);
	const painted = (o: (typeof project.objects)[number]) => {
		const kinds: PaintKind[] = [];
		for (const p of o.parts)
			for (const k of Object.keys(paintCounts(p)) as PaintKind[])
				if (!kinds.includes(k)) kinds.push(k);
		return kinds.map((k) => PAINT_KIND_LABEL[k].toLowerCase());
	};

	function pick(e: MouseEvent, objectId: string, instanceId: string) {
		ws.select(
			clickPick(ws.selection, { objectId, instanceId }, e.shiftKey || e.ctrlKey || e.metaKey)
		);
	}
</script>

<section class="panel ol" aria-label="Objects on this plate">
	<div class="ol-head">
		<h2 class="panel-title">Objects</h2>
		<span class="count">{rows.length} on plate {ws.plate}</span>
	</div>
	{#if !rows.length}
		<p class="panel-empty">Nothing on this plate yet. Add a model from the toolbar.</p>
	{:else}
		<ul class="objects" role="listbox" aria-multiselectable="true" aria-label="Objects">
			{#each rows as { obj, instance, copies } (obj.id)}
				<li>
					<button
						class="row"
						class:on={selected(obj.id) && !ws.selection.partId}
						role="option"
						aria-selected={selected(obj.id)}
						onclick={(e) => pick(e, obj.id, instance)}
					>
						<i
							class="fchip"
							style:--c={colour(objectFilament(obj))}
							title="Filament {objectFilament(obj)}"
						></i>
						<span class="name">{obj.name}</span>
						{#if copies > 1}<span class="tag">×{copies}</span>{/if}
						{#if !obj.printable}<span class="tag">not printed</span>{/if}
						{#if Object.keys(obj.config).filter((k) => k !== 'extruder').length}<span
								class="tag"
								title="Own settings">⚙</span
							>{/if}
						{#if obj.heightRanges.length}<span class="tag" title="Height ranges"
								>≡{obj.heightRanges.length}</span
							>{/if}
						{#each painted(obj) as k (k)}<span class="tag" title="Painted {k}">✎ {k}</span>{/each}
					</button>
					{#if obj.parts.length > 1}
						<ul class="parts">
							{#each obj.parts as part (part.id)}
								<li>
									<button
										class="row part"
										class:on={ws.selection.partId === part.id}
										onclick={() => ws.select(pickPart(project, obj.id, part.id))}
									>
										<i
											class="fchip"
											class:hollow={part.type !== 'model'}
											style:--c={colour(partFilament(obj, part))}
										></i>
										<span class="name">{part.name}</span>
										<span class="tag">{PART_TYPE_LABEL[part.type]}</span>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	<div class="ol-actions">
		<button
			class="mini"
			disabled={!ws.selection.items.length}
			onclick={() => ws.duplicateSelection()}
			title="Copy (Ctrl+D)">Copy</button
		>
		<button
			class="mini danger-mini"
			disabled={!ws.selection.items.length}
			onclick={() => ws.deleteSelection()}
			title="Delete (Del)">Delete</button
		>
	</div>
</section>

<style>
	.ol {
		display: grid;
		gap: 8px;
	}
	.ol-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.count {
		font-size: 12px;
		color: var(--muted);
	}
	.objects,
	.parts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	.parts {
		padding-left: 18px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 6px;
		width: 100%;
		padding: 5px 8px;
		border: 1px solid transparent;
		border-radius: 8px;
		background: none;
		color: var(--text);
		text-align: left;
		font-size: 13px;
		cursor: pointer;
	}
	.row:hover {
		background: rgb(var(--hi) / 0.05);
	}
	.row.on {
		border-color: var(--line-strong);
		background: rgb(var(--hi) / 0.08);
	}
	.part {
		font-size: 12.5px;
	}
	.name {
		flex: 1 1 120px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fchip {
		width: 12px;
		height: 12px;
		border-radius: 4px;
		background: var(--c);
		box-shadow: inset 0 0 0 1px var(--line-strong);
		flex: none;
	}
	.fchip.hollow {
		background: none;
		box-shadow: inset 0 0 0 2px var(--c);
	}
	.tag {
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
	}
	.ol-actions {
		display: flex;
		gap: 6px;
	}
</style>
