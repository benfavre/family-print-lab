<script lang="ts">
	import { PART_TYPE_LABEL, filamentCss, projectFacts } from '$lib/client/slicer-3mf';
	import type { Project } from '$lib/shared/slicer/project';

	let { project }: { project: Project } = $props();
	const facts = $derived(projectFacts(project));
	const byId = $derived(new Map(project.objects.map((o) => [o.id, o])));
	const filament = (n: number | undefined) =>
		n ? project.filaments.find((f) => f.index === n) : undefined;
	const objectFilament = (config: Record<string, string | string[]>) => {
		const v = config.extruder;
		return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;
	};
	const meta = $derived(
		(
			[
				['Title', project.meta.title],
				['Designer', project.meta.designer],
				['Licence', project.meta.license],
				['Origin', project.meta.origin],
				['Made with', project.meta.application]
			] as const
		).filter(([, v]) => v)
	);
</script>

<div class="overview">
	<section class="panel" aria-label="Summary">
		<h2 class="panel-title">In this project</h2>
		<p class="summary">
			{project.objects.length} object{project.objects.length === 1 ? '' : 's'} ({facts.instances} on the
			plates) · {project.plates.length} plate{project.plates.length === 1 ? '' : 's'} ·
			{facts.triangles.toLocaleString()} triangles
		</p>
		<div class="tags">
			{#if facts.modifiers}<span class="tag"
					>{facts.modifiers} modifier{facts.modifiers === 1 ? '' : 's'}</span
				>{/if}
			{#if facts.heightRanges}<span class="tag"
					>{facts.heightRanges} height range{facts.heightRanges === 1 ? '' : 's'}</span
				>{/if}
			{#if facts.variableLayers}<span class="tag">Variable layer height</span>{/if}
			{#each facts.painting as p (p)}<span class="tag">Painted {p}</span>{/each}
		</div>
		{#if meta.length}
			<dl class="facts">
				{#each meta as [k, v] (k)}<dt>{k}</dt>
					<dd>{v}</dd>{/each}
			</dl>
		{/if}
	</section>

	<section class="panel" aria-label="Printer and filaments">
		<h2 class="panel-title">Printer and filaments</h2>
		<dl class="facts">
			<dt>Printer</dt>
			<dd>{project.presets.printer.name || 'Not set: Bambu Studio uses the one you have open'}</dd>
			<dt>Process</dt>
			<dd>{project.presets.process.name || 'Not set'}</dd>
		</dl>
		{#if project.filaments.length}
			<ol class="filaments">
				{#each project.filaments as f (f.index)}
					<li>
						<span
							class="swatch"
							style:background={filamentCss(f.color) ?? 'transparent'}
							aria-hidden="true"
						></span>
						<span class="num">{f.index}</span>
						<span>{f.type || 'Filament'}</span>
						<small>{f.preset.name}</small>
					</li>
				{/each}
			</ol>
		{:else}
			<p class="panel-empty">No filaments in the file yet.</p>
		{/if}
	</section>

	<section class="panel wide" aria-label="Plates">
		<h2 class="panel-title">Plates</h2>
		<div class="plates">
			{#each project.plates as plate (plate.index)}
				<article class="plate">
					<h3>
						Plate {plate.index}{#if plate.name}: {plate.name}{/if}
						{#if plate.locked}<span class="tag">Locked</span>{/if}
					</h3>
					<p class="plate-settings">
						{[
							plate.bedType,
							plate.printSequence === 'by object' ? 'One object at a time' : null,
							plate.spiralVase ? 'Spiral vase' : null,
							plate.filamentMaps?.length ? `Nozzles ${plate.filamentMaps.join(' ')}` : null,
							plate.customGcode?.items.length
								? `${plate.customGcode.items.length} layer change${plate.customGcode.items.length === 1 ? '' : 's'}`
								: null
						]
							.filter(Boolean)
							.join(' · ') || 'Project settings'}
					</p>
					{#if plate.instances.length}
						<ul>
							{#each plate.instances as ref (ref.objectId + ref.instanceId)}
								<li>{byId.get(ref.objectId)?.name ?? ref.objectId}</li>
							{/each}
						</ul>
					{:else}
						<p class="panel-empty">Empty</p>
					{/if}
				</article>
			{/each}
		</div>
	</section>

	<section class="panel wide" aria-label="Objects">
		<h2 class="panel-title">Objects</h2>
		<ul class="objects">
			{#each project.objects as o (o.id)}
				{@const of = filament(objectFilament(o.config))}
				<li class="object">
					<div class="object-head">
						{#if of}<span
								class="swatch"
								style:background={filamentCss(of.color) ?? 'transparent'}
								title="Filament {of.index}"
							></span>{/if}
						<strong>{o.name}</strong>
						<small
							>{o.instances.length > 1 ? `${o.instances.length} copies · ` : ''}{o.parts.length}
							part{o.parts.length === 1 ? '' : 's'}{Object.keys(o.config).length
								? ` · ${Object.keys(o.config).length} own setting${Object.keys(o.config).length === 1 ? '' : 's'}`
								: ''}{o.printable ? '' : ' · Not printed'}</small
						>
					</div>
					{#if o.parts.length > 1 || o.parts.some((p) => p.paint || p.type !== 'model')}
						<ul class="parts">
							{#each o.parts as p (p.id)}
								{@const pf = filament(p.filament)}
								<li>
									{#if pf}<span
											class="swatch small"
											style:background={filamentCss(pf.color) ?? 'transparent'}
											title="Filament {pf.index}"
										></span>{/if}
									<span>{p.name}</span>
									{#if p.type !== 'model'}<span class="tag">{PART_TYPE_LABEL[p.type]}</span>{/if}
									{#if p.paint}<span class="tag">Painted</span>{/if}
									{#if p.text}<span class="tag">Text</span>{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
</div>

<style>
	.overview {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 14px;
	}
	.wide {
		grid-column: 1 / -1;
	}
	.summary {
		margin: 0 0 8px;
		font-size: 13.5px;
		color: var(--text-2);
	}
	.tags {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.tag {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 11.5px;
		color: var(--muted);
		box-shadow: 0 0 0 1px var(--line) inset;
	}
	.facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 12px;
		margin: 10px 0 0;
		font-size: 13px;
	}
	.facts dt {
		color: var(--muted);
	}
	.facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.filaments,
	.objects,
	.parts,
	.plate ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.filaments {
		display: grid;
		gap: 4px;
		margin-top: 10px;
		font-size: 13px;
	}
	.filaments li,
	.parts li,
	.object-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.filaments small,
	.object-head small {
		color: var(--dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.num {
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}
	.swatch {
		flex: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--line);
	}
	.swatch.small {
		width: 10px;
		height: 10px;
	}
	.plates {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 10px;
	}
	.plate {
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: 10px;
	}
	.plate h3 {
		display: flex;
		gap: 6px;
		align-items: center;
		margin: 0 0 4px;
		font-size: 13.5px;
	}
	.plate-settings {
		margin: 0 0 6px;
		font-size: 12.5px;
		color: var(--muted);
	}
	.plate li {
		font-size: 13px;
	}
	.objects {
		display: grid;
		gap: 8px;
	}
	.object {
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
	}
	.parts {
		display: grid;
		gap: 3px;
		margin: 6px 0 0 22px;
		font-size: 13px;
	}
</style>
