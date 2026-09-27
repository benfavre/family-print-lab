<script lang="ts">
	import { untrack } from 'svelte';
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import {
		addHeightRange,
		findObject,
		heightRangeProblems,
		instanceBox,
		objectFilament,
		partFilament,
		removePart,
		setConfig,
		type Primitive
	} from '$lib/client/slicer/edit';
	import { decompose, recompose, type Parts } from '$lib/client/slicer/matrix';
	import { PAINT_CAPABILITY, PAINT_KIND_LABEL, type PaintKind } from '$lib/client/slicer/paint';
	import { PRIMITIVE_LABEL } from '$lib/client/slicer/primitives';
	import { RANGE_KEYS } from '$lib/client/slicer/settings';
	import { PART_TYPE_LABEL } from '$lib/client/slicer-3mf';
	import type { ConfigValue, PartType } from '$lib/shared/slicer/project';
	import SettingsEditor from './SettingsEditor.svelte';
	import LayerHeightEditor from './LayerHeightEditor.svelte';
	import CutPanel from './CutPanel.svelte';
	import SimplifyPanel from './SimplifyPanel.svelte';

	// The selected object (or part): name, position, rotation and scale, filament, its own settings,
	// height ranges, variable layer height, parts and modifiers, and painting.
	let { ws }: { ws: WorkspaceState } = $props();
	const project = $derived(ws.project);
	const pick = $derived(ws.selection.items.length === 1 ? ws.selection.items[0] : null);
	const obj = $derived(pick ? project.objects.find((o) => o.id === pick.objectId) : undefined);
	const inst = $derived(obj?.instances.find((i) => i.id === pick?.instanceId));
	const part = $derived(
		obj && ws.selection.partId ? obj.parts.find((p) => p.id === ws.selection.partId) : undefined
	);
	const live = $derived(
		ws.dragging && pick && ws.dragging.pick.objectId === pick.objectId
			? ws.dragging.transform
			: inst?.transform
	);
	const parts = $derived(live ? decompose(live) : null);
	const size = $derived.by(() => {
		void ws.meshVersion;
		if (!obj || !live) return null;
		const b = instanceBox(project, obj, live, ws.meshSource);
		return [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map((v) => Math.round(v * 100) / 100);
	});
	let uniform = $state(true);
	let partFile = $state<HTMLInputElement>();
	let partFileType = $state<PartType>('modifier');
	const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

	function setPart(field: keyof Parts, axis: number, value: number) {
		if (!parts || !pick || !Number.isFinite(value)) return;
		const next: Parts = structuredClone($state.snapshot(parts));
		if (field === 'scale') {
			const v = value / 100;
			if (uniform) {
				const ratio = v / (next.scale[axis] || 1);
				next.scale = next.scale.map((s) => s * ratio) as Parts['scale'];
			} else next.scale[axis] = v;
		} else next[field][axis] = value;
		ws.setTransform(
			pick,
			recompose(next),
			field === 'position' ? 'Move' : field === 'rotation' ? 'Rotate' : 'Scale'
		);
	}

	function setObjectConfig(key: string, value: ConfigValue | undefined) {
		if (!obj) return;
		const id = obj.id,
			partId = part?.id;
		ws.change('Change setting', (d) => {
			const o = findObject(d, id);
			const target = partId ? o.parts.find((p) => p.id === partId)! : o;
			setConfig(target.config, key, value);
		});
	}

	function rename(name: string) {
		if (!obj || !name.trim()) return;
		const id = obj.id,
			partId = part?.id;
		ws.change('Rename', (d) => {
			const o = findObject(d, id);
			if (partId) o.parts.find((p) => p.id === partId)!.name = name.trim().slice(0, 200);
			else o.name = name.trim().slice(0, 200);
		});
	}

	function setFilament(n: number) {
		if (!obj) return;
		const id = obj.id,
			partId = part?.id;
		ws.change('Change filament', (d) => {
			const o = findObject(d, id);
			if (partId) o.parts.find((p) => p.id === partId)!.filament = n;
			else o.config.extruder = String(n);
		});
	}

	function setType(type: PartType) {
		if (!obj || !part) return;
		const id = obj.id,
			partId = part.id;
		ws.change('Change part type', (d) => {
			const o = findObject(d, id);
			const p = o.parts.find((x) => x.id === partId)!;
			if (
				p.type === 'model' &&
				type !== 'model' &&
				o.parts.filter((x) => x.type === 'model').length === 1
			)
				throw new Error('An object needs at least one model part.');
			p.type = type;
		});
	}

	function setPrintable(on: boolean) {
		if (!obj) return;
		const id = obj.id;
		ws.change(on ? 'Print it' : 'Do not print', (d) => {
			findObject(d, id).printable = on;
		});
	}

	function deletePart() {
		if (!obj || !part) return;
		const id = obj.id,
			partId = part.id;
		ws.change('Delete part', (d) => removePart(d, id, partId));
	}

	function addRange() {
		if (!obj) return;
		const id = obj.id;
		const top = size?.[2] ?? 10;
		ws.change('Add height range', (d) => void addHeightRange(findObject(d, id), top));
	}

	function setRange(i: number, patch: { minZ?: number; maxZ?: number }) {
		if (!obj) return;
		const id = obj.id;
		ws.change('Change height range', (d) =>
			Object.assign(findObject(d, id).heightRanges[i], patch)
		);
	}

	function setRangeConfig(i: number, key: string, value: ConfigValue | undefined) {
		if (!obj) return;
		const id = obj.id;
		ws.change('Change height range', (d) =>
			setConfig(findObject(d, id).heightRanges[i].config, key, value)
		);
	}

	function removeRange(i: number) {
		if (!obj) return;
		const id = obj.id;
		ws.change('Delete height range', (d) => {
			findObject(d, id).heightRanges.splice(i, 1);
		});
	}

	function addPrimitive(kind: Primitive) {
		void ws.addPrimitive(kind, 'modifier');
	}

	function pickPartFile(type: PartType) {
		partFileType = type;
		partFile?.click();
	}

	const filamentOf = $derived(obj ? (part ? partFilament(obj, part) : objectFilament(obj)) : 1);
	const kinds: PaintKind[] = ['supports', 'seam', 'color', 'fuzzySkin'];
	const canModify = $derived(ws.can('modifiers'));
	const axes = ['X', 'Y', 'Z'];
</script>

{#if ws.selection.items.length > 1}
	<section class="panel op" aria-label="Selection">
		<h2 class="panel-title">{ws.selection.items.length} objects</h2>
		<div class="buttons">
			<button class="mini" onclick={() => ws.dropSelection()}>Drop to bed</button>
			{#if ws.can('orient')}<button class="mini" onclick={() => ws.orient()}>Orient</button>{/if}
		</div>
	</section>
{:else if obj && inst && parts}
	<section class="panel op" aria-label={part ? 'Part' : 'Object'}>
		<div class="op-head">
			<input
				class="title-input"
				aria-label="Name"
				value={part?.name ?? obj.name}
				onchange={(e) => rename(e.currentTarget.value)}
			/>
			{#if part}<span class="tag">{PART_TYPE_LABEL[part.type]}</span>{/if}
		</div>

		{#if !part}
			<div class="xform" role="group" aria-label="Position, rotation and scale">
				<span></span>
				{#each axes as a (a)}<span class="axis">{a}</span>{/each}
				<span class="lbl">Position</span>
				{#each [0, 1, 2] as i (i)}
					<input
						type="number"
						step="1"
						aria-label="Position {axes[i]}"
						value={round(parts.position[i])}
						onchange={(e) => setPart('position', i, +e.currentTarget.value)}
					/>
				{/each}
				<span class="lbl">Rotation</span>
				{#each [0, 1, 2] as i (i)}
					<input
						type="number"
						step="15"
						aria-label="Rotation {axes[i]} in degrees"
						value={round(parts.rotation[i], 1)}
						onchange={(e) => setPart('rotation', i, +e.currentTarget.value)}
					/>
				{/each}
				<span class="lbl">Scale %</span>
				{#each [0, 1, 2] as i (i)}
					<input
						type="number"
						step="5"
						min="1"
						aria-label="Scale {axes[i]} in percent"
						value={round(parts.scale[i] * 100, 1)}
						onchange={(e) => setPart('scale', i, +e.currentTarget.value)}
					/>
				{/each}
				{#if size}
					<span class="lbl">Size mm</span>
					{#each size as s, i (i)}<span class="size">{s}</span>{/each}
				{/if}
			</div>
			<label class="check"><input type="checkbox" bind:checked={uniform} /> Scale evenly</label>
			<div class="buttons">
				<button
					class="mini"
					onclick={() => ws.dropSelection()}
					title="Rest the lowest point on the bed">Drop to bed</button
				>
				<button
					class="mini"
					class:on={ws.layFace}
					aria-pressed={ws.layFace}
					onclick={() => ((ws.layFace = !ws.layFace), (ws.paint = null))}
					title="Then click the face to put down">Lay on face</button
				>
				{#if ws.can('orient')}<button class="mini" onclick={() => ws.orient()}>Orient</button>{/if}
				<label class="check"
					><input
						type="checkbox"
						checked={obj.printable}
						onchange={(e) => setPrintable(e.currentTarget.checked)}
					/> Print</label
				>
			</div>
		{/if}

		<label class="field"
			>Filament
			<select value={String(filamentOf)} onchange={(e) => setFilament(+e.currentTarget.value)}>
				{#each project.filaments as f (f.index)}
					<option value={String(f.index)}>{f.index} · {f.type} {f.color}</option>
				{/each}
			</select>
		</label>
		{#if part && obj.parts.indexOf(part) > 0}
			<label class="field"
				>Type
				<select value={part.type} onchange={(e) => setType(e.currentTarget.value as PartType)}>
					{#each Object.entries(PART_TYPE_LABEL) as [t, label] (t)}<option value={t}>{label}</option
						>{/each}
				</select>
			</label>
		{/if}

		<details open={Object.keys((part ?? obj).config).some((k) => k !== 'extruder')}>
			<summary>{part ? 'Part settings' : 'Object settings'}</summary>
			<SettingsEditor
				config={(part ?? obj).config}
				defaults={ws.defaults}
				onset={setObjectConfig}
			/>
		</details>

		{#if part}
			<button class="mini danger-mini" onclick={deletePart}>Delete part</button>
		{:else}
			<details open={obj.heightRanges.length > 0}>
				<summary
					>Height ranges{obj.heightRanges.length ? ` (${obj.heightRanges.length})` : ''}</summary
				>
				{#if !ws.can('height_ranges')}<p class="hint">
						Saved in the file; this slicer leaves them out.
					</p>{/if}
				{#each obj.heightRanges as r, i (i)}
					<div class="range">
						<div class="range-z">
							<label
								>From <input
									type="number"
									step="0.2"
									min="0"
									value={r.minZ}
									onchange={(e) => setRange(i, { minZ: +e.currentTarget.value })}
								/></label
							>
							<label
								>to <input
									type="number"
									step="0.2"
									min="0"
									value={r.maxZ}
									onchange={(e) => setRange(i, { maxZ: +e.currentTarget.value })}
								/> mm</label
							>
							<button
								class="icon-button"
								aria-label="Delete this height range"
								onclick={() => removeRange(i)}>×</button
							>
						</div>
						<SettingsEditor
							config={r.config}
							defaults={ws.defaults}
							keys={RANGE_KEYS}
							onset={(k, v) => setRangeConfig(i, k, v)}
						/>
					</div>
				{/each}
				{#each heightRangeProblems(obj) as p (p)}<p class="hint warn">{p}</p>{/each}
				<button class="mini" onclick={addRange}>+ Height range</button>
			</details>

			{#key obj.id}
				<!-- Opened for an object that has layer heights; Reset does not fold it away. -->
				<details open={untrack(() => !!obj.layerHeightProfile?.length)}>
					<summary>Variable layer height{obj.layerHeightProfile?.length ? ' (set)' : ''}</summary>
					<LayerHeightEditor {ws} {obj} />
				</details>
			{/key}

			<details>
				<summary>Parts and modifiers ({obj.parts.length})</summary>
				{#if !canModify}<p class="hint">
						Saved in the file; this slicer leaves modifiers out.
					</p>{/if}
				<div class="buttons">
					{#each Object.keys(PRIMITIVE_LABEL) as k (k)}
						<button class="mini" onclick={() => addPrimitive(k as Primitive)}
							>+ {PRIMITIVE_LABEL[k as Primitive]} modifier</button
						>
					{/each}
					<button class="mini" onclick={() => pickPartFile('modifier')}>+ Modifier from file</button
					>
					<button class="mini" onclick={() => pickPartFile('negative')}>+ Negative part</button>
					<button class="mini" onclick={() => pickPartFile('model')}>+ Part</button>
					<button class="mini" onclick={() => ws.addPrimitive('box', 'support_blocker')}
						>+ Support blocker</button
					>
					<button class="mini" onclick={() => ws.addPrimitive('box', 'support_enforcer')}
						>+ Support enforcer</button
					>
				</div>
				<input
					bind:this={partFile}
					type="file"
					accept=".stl,.3mf,.obj"
					hidden
					onchange={(e) => {
						const f = e.currentTarget.files?.[0];
						e.currentTarget.value = '';
						if (f) void ws.addPartFile(f, partFileType as 'modifier');
					}}
				/>
			</details>

			<details open={!!ws.paint}>
				<summary>Painting</summary>
				<div class="buttons">
					{#each kinds as k (k)}
						<button
							class="mini"
							class:on={ws.paint?.kind === k}
							aria-pressed={ws.paint?.kind === k}
							onclick={() => (ws.paint?.kind === k ? (ws.paint = null) : ws.startPaint(k))}
							title={ws.can(PAINT_CAPABILITY[k])
								? ''
								: 'Saved in the file; this slicer leaves it out'}
							>{PAINT_KIND_LABEL[k]}{ws.can(PAINT_CAPABILITY[k]) ? '' : ' *'}</button
						>
					{/each}
				</div>
				{#if kinds.some((k) => !ws.can(PAINT_CAPABILITY[k]))}
					<p class="hint">* Saved in the file for Bambu Studio; this slicer leaves it out.</p>
				{/if}
			</details>
		{/if}
		{#if !part}<CutPanel {ws} object={obj} instance={inst} />
			<SimplifyPanel {ws} object={obj} />{/if}
	</section>
{/if}

<style>
	.op {
		display: grid;
		gap: 10px;
	}
	.op-head {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.title-input {
		flex: 1;
		min-width: 0;
		font-weight: 600;
	}
	.tag {
		font-size: 11px;
		color: var(--muted);
	}
	.xform {
		display: grid;
		grid-template-columns: auto repeat(3, minmax(0, 1fr));
		gap: 4px 6px;
		align-items: center;
		font-size: 12px;
	}
	.xform input {
		min-width: 0;
		width: 100%;
	}
	.axis {
		text-align: center;
		color: var(--muted);
		font-size: 11px;
	}
	.lbl {
		color: var(--muted);
		white-space: nowrap;
	}
	.size {
		text-align: center;
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}
	.mini.on {
		border-color: var(--cyan);
		color: var(--cyan);
	}
	.check {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		font-size: 12.5px;
	}
	details {
		display: grid;
		gap: 8px;
	}
	details > :global(*:not(summary)) {
		margin-top: 8px;
	}
	summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.warn {
		color: var(--err-text);
	}
	.range {
		display: grid;
		gap: 6px;
		padding: 8px;
		border: 1px solid var(--line);
		border-radius: 10px;
	}
	.range-z {
		display: flex;
		gap: 8px;
		align-items: center;
		font-size: 12.5px;
	}
	.range-z input {
		width: 70px;
	}
</style>
