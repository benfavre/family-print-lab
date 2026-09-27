<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import type { Spool } from '$lib/shared/domain';
	import type { PresetRef } from '$lib/shared/slicer/project';
	import type { PresetSummary } from '$lib/shared/slicer/profiles';
	import { getJson, query, refOf, sameRef } from './api';

	// The spool editor's slicer preset: which filament preset jobs on this spool slice with. Presets
	// are listed for the first printer; other printers get the same Bambu filament in their variant.
	let { spool, draft }: { spool: Spool | null; draft: Record<string, unknown> } = $props();
	const { lab } = useApp();

	let presets = $state<PresetSummary[] | null>(null);
	let error = $state('');
	let linked = $state<PresetRef | null>(null);
	let busy = $state(false);

	const type = $derived(
		String(draft.material ?? '')
			.toUpperCase()
			.split(/[\s-]/)[0] ?? ''
	);
	const choices = $derived(
		(presets ?? []).filter(
			(p) => !type || (p.filamentType ?? '').toUpperCase() === type || sameRef(refOf(p), linked)
		)
	);
	const valueOf = (r: PresetRef | null) =>
		r ? (r.source === 'user' ? `user:${r.userPresetId}` : `system:${r.name}`) : '';

	$effect(() => {
		if (!spool) return;
		const id = spool.id;
		void (async () => {
			const model = lab.primaryPrinter?.model;
			const [list, current] = await Promise.all([
				getJson<PresetSummary[]>(`/api/slicer/profiles?${query({ kind: 'filament', model })}`),
				getJson<{ preset: PresetRef | null }>(`/api/slicer/presets/spools/${id}`)
			]);
			presets = list.data;
			error = list.error ?? current.error ?? '';
			linked = current.data?.preset ?? null;
		})();
	});

	async function choose(value: string) {
		if (!spool) return;
		const p = (presets ?? []).find((x) => valueOf(refOf(x)) === value);
		busy = true;
		const r = await lab.call<{ preset: PresetRef | null }>(
			'PUT',
			`/api/slicer/presets/spools/${spool.id}`,
			{ preset: p ? refOf(p) : null },
			p ? 'Slicer preset linked.' : 'Slicer preset unlinked.'
		);
		busy = false;
		if (r) linked = r.preset;
	}
</script>

<label class="field"
	>Slicer preset
	{#if !spool}
		<small>Save the spool first, then pick the filament preset it slices with.</small>
	{:else if error}
		<small>{error}</small>
	{:else if presets}
		<select
			disabled={busy}
			value={valueOf(linked)}
			onchange={(e) => void choose(e.currentTarget.value)}
		>
			<option value="">Automatic, from the material</option>
			{#each choices as p (p.source + p.id)}
				<option value={valueOf(refOf(p))}>{p.name}{p.source === 'user' ? ' · yours' : ''}</option>
			{/each}
		</select>
		<small>Saved straight away. AMS trays match presets by Bambu’s filament id.</small>
	{:else}
		<small>Loading presets…</small>
	{/if}
</label>
