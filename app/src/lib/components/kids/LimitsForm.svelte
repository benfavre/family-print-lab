<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import type { KidLimits } from '$lib/shared/kids';

	// A child's limits; an empty box means no limit of that kind.
	let {
		profileId,
		name,
		limits,
		ondone
	}: { profileId: string; name: string; limits: KidLimits; ondone: () => void } = $props();
	const { lab } = useApp();
	const FIELDS: { key: keyof KidLimits; label: string; unit: string; hint?: string }[] = [
		{ key: 'printsPerDay', label: 'Prints a day', unit: '' },
		{ key: 'printsPerWeek', label: 'Prints a week', unit: '' },
		{ key: 'gramsPerWeek', label: 'Filament a week', unit: 'g' },
		{ key: 'gramsPerMonth', label: 'Filament a month', unit: 'g' },
		{
			key: 'needApprovalOverGrams',
			label: 'Say yes by itself up to',
			unit: 'g',
			hint: 'Smaller requests within the limits are queued without asking you.'
		}
	];
	// The form starts from the limits it was opened with.
	// svelte-ignore state_referenced_locally
	let draft = $state<Record<keyof KidLimits, number | null | undefined>>({ ...limits });

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const body = Object.fromEntries(
			FIELDS.map((f) => {
				const v = draft[f.key];
				return [f.key, typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null];
			})
		);
		if (await lab.call('PUT', `/api/kids/limits/${profileId}`, body, `Limits for ${name} saved.`))
			ondone();
	}
</script>

<form class="limits-form" onsubmit={save} aria-label="Limits for {name}">
	<div class="limit-fields">
		{#each FIELDS as f (f.key)}
			<label class="field"
				>{f.label}
				<span class="with-unit">
					<input
						type="number"
						min="0"
						step="1"
						inputmode="numeric"
						placeholder="No limit"
						bind:value={draft[f.key]}
					/>{#if f.unit}<span class="unit">{f.unit}</span>{/if}
				</span>
				{#if f.hint}<small>{f.hint}</small>{/if}
			</label>
		{/each}
	</div>
	<p class="note">
		Limits count what {name} asks for, from midnight, Monday and the 1st of the month. Prints that fail
		or are stopped do not count. Leave a box empty for no limit.
	</p>
	<div class="actions">
		<button class="primary">Save limits</button>
		<button type="button" class="ghost-button" onclick={ondone}>Cancel</button>
	</div>
</form>

<style>
	.limits-form {
		display: grid;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: var(--panel-strong);
	}
	.limit-fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 0 12px;
	}
	.with-unit {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.unit {
		color: var(--dim);
	}
	.note {
		margin: 0;
		color: var(--dim);
		font-size: 12.5px;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
</style>
