<script lang="ts">
	import { untrack } from 'svelte';
	import { MATERIALS } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import EditorShell from './EditorShell.svelte';
	import ExpandableText from './ExpandableText.svelte';

	let {
		id,
		preset,
		onclose
	}: { id: string | null; preset: Record<string, unknown>; onclose: () => void } = $props();
	const { lab, ui } = useApp();
	// The editor is recreated for each record ({#key}), so reading props once is intended.
	const existing = untrack(() => (id ? lab.spool(id) : undefined));
	const src = untrack(() => ({
		brand: '',
		material: 'PLA',
		colorName: '',
		colorHex: '#5ee7ff',
		totalGrams: 1000,
		remainingGrams: 1000,
		cost: null as number | null,
		notes: '',
		...preset,
		...(existing ?? {})
	}));
	let f = $state({
		brand: src.brand,
		material: src.material,
		colorName: src.colorName,
		colorHex: src.colorHex,
		totalGrams: src.totalGrams,
		remainingGrams: src.remainingGrams,
		cost: src.cost,
		notes: src.notes
	});
	let busy = $state(false);
	const materials = $derived(
		MATERIALS.includes(f.material as never) ? MATERIALS : [...MATERIALS, f.material]
	);

	async function save() {
		busy = true;
		const body = {
			...f,
			totalGrams: Number(f.totalGrams),
			remainingGrams: Math.min(Number(f.remainingGrams), Number(f.totalGrams)),
			cost: f.cost === null || (f.cost as unknown) === '' ? null : Number(f.cost)
		};
		const ok = existing
			? await lab.call(
					'PATCH',
					`/api/spools/${existing.id}`,
					{ ...body, version: existing.version },
					'Saved.'
				)
			: await lab.call('POST', '/api/spools', body, 'Spool added to the shelf.');
		busy = false;
		if (ok) onclose();
	}
	async function remove() {
		if (
			existing &&
			(await ui.ask(
				'Remove this spool?',
				'Print jobs keep their other details but no longer point to it.'
			)) &&
			(await lab.call('DELETE', `/api/spools/${existing.id}`, undefined, 'Spool removed.'))
		)
			onclose();
	}
</script>

<EditorShell
	subject={[f.colorName, f.material].filter(Boolean).join(' ')}
	id="spool-editor"
	eyebrow="FILAMENT"
	title={existing ? 'Edit spool' : 'Add a spool'}
	{busy}
	error=""
	saveLabel={existing ? 'Save changes' : 'Add spool'}
	onsubmit={save}
	{onclose}
	ondelete={existing ? remove : undefined}
>
	<div class="fields-row">
		<label class="field">Color name<input bind:value={f.colorName} maxlength="80" required /></label
		>
		<label class="field">Swatch<input type="color" bind:value={f.colorHex} /></label>
	</div>
	<div class="fields-row">
		<label class="field"
			>Material<select bind:value={f.material}
				>{#each materials as m (m)}<option>{m}</option>{/each}</select
			></label
		>
		<label class="field">Brand<input bind:value={f.brand} maxlength="80" /></label>
	</div>
	<div class="fields-row">
		<label class="field"
			>Spool size (g)<input
				type="number"
				min="1"
				max="100000"
				step="1"
				required
				bind:value={f.totalGrams}
			/></label
		>
		<label class="field"
			>Remaining (g)<input
				type="number"
				min="0"
				max="100000"
				step="0.1"
				required
				bind:value={f.remainingGrams}
			/><small>Weigh it and subtract the empty spool for accuracy.</small></label
		>
	</div>
	<label class="field"
		>Price paid (optional)<input type="number" min="0" step="0.01" bind:value={f.cost} /><small
			>Used to estimate material cost per print.</small
		></label
	>
	<ExpandableText
		label="Notes"
		bind:value={f.notes}
		maxlength={1000}
		ai={{
			actions: ['tidy'],
			context: () => ({ Spool: `${f.colorName} ${f.material} ${f.brand}`.trim() })
		}}
	/>
</EditorShell>
