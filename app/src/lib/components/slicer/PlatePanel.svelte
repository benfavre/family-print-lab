<script lang="ts">
	import type { WorkspaceState } from '$lib/client/slicer/workspace.svelte';
	import { removePlate, setPlate } from '$lib/client/slicer/edit';
	import { useApp } from '$lib/client/app.svelte';
	import type { Plate } from '$lib/shared/slicer/project';

	// The active plate's settings, as Bambu Studio's plate settings dialog: bed type, print sequence,
	// spiral vase (model_settings.config plate metadata), name and lock.
	let { ws }: { ws: WorkspaceState } = $props();
	const { ui } = useApp();
	const plate = $derived(ws.project.plates.find((p) => p.index === ws.plate));
	// curr_bed_type names (BedType, src/libslic3r/PrintConfig.cpp at the pinned tag).
	const BEDS = [
		'Cool Plate',
		'Engineering Plate',
		'High Temp Plate',
		'Textured PEI Plate',
		'Supertack Plate'
	];

	function set(label: string, patch: Partial<Plate>) {
		const index = ws.plate;
		ws.change(label, (d) => setPlate(d, index, patch));
	}

	async function remove() {
		if (!plate) return;
		const n = plate.instances.length;
		if (
			n &&
			!(await ui.ask(
				`Delete plate ${plate.index}?`,
				`${n} object${n === 1 ? '' : 's'} on it go${n === 1 ? 'es' : ''} too. You can undo this.`
			))
		)
			return;
		const index = plate.index;
		ws.change('Delete plate', (d) => removePlate(d, ws.bed, index));
	}
</script>

{#if plate}
	<section class="panel plp" aria-label="Plate {plate.index}">
		<h2 class="panel-title">Plate {plate.index}</h2>
		<label class="field"
			>Name <input
				type="text"
				maxlength="120"
				value={plate.name}
				placeholder="Plate {plate.index}"
				onchange={(e) => set('Rename plate', { name: e.currentTarget.value.trim() })}
			/></label
		>
		<label class="field"
			>Bed
			<select
				value={plate.bedType ?? ''}
				onchange={(e) => set('Change bed', { bedType: e.currentTarget.value || undefined })}
			>
				<option value="">Same as the project</option>
				{#each BEDS as b (b)}<option value={b}>{b}</option>{/each}
				{#if plate.bedType && !BEDS.includes(plate.bedType)}<option value={plate.bedType}
						>{plate.bedType}</option
					>{/if}
			</select>
		</label>
		<label class="field"
			>Print sequence
			<select
				value={plate.printSequence ?? ''}
				onchange={(e) =>
					set('Change print sequence', {
						printSequence: (e.currentTarget.value || undefined) as Plate['printSequence']
					})}
			>
				<option value="">Same as the process</option>
				<option value="by layer">By layer</option>
				<option value="by object">By object</option>
			</select>
		</label>
		<label class="check"
			><input
				type="checkbox"
				checked={!!plate.spiralVase}
				onchange={(e) => set('Spiral vase', { spiralVase: e.currentTarget.checked || undefined })}
			/> Spiral vase</label
		>
		<label class="check" title="Arranging leaves a locked plate as it is"
			><input
				type="checkbox"
				checked={plate.locked}
				onchange={(e) =>
					set(e.currentTarget.checked ? 'Lock plate' : 'Unlock plate', {
						locked: e.currentTarget.checked
					})}
			/> Locked</label
		>
		{#if ws.project.plates.length > 1}
			<button class="mini danger-mini" onclick={remove}>Delete plate</button>
		{/if}
	</section>
{/if}

<style>
	.plp {
		display: grid;
		gap: 10px;
	}
	.check {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		font-size: 13px;
	}
</style>
