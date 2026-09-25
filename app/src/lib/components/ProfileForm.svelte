<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { KID_LEVEL_LABEL, KID_LEVELS, PROFILE_COLORS, type KidLevel } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import EditorShell from './EditorShell.svelte';
	import ExpandableText from './ExpandableText.svelte';

	let { id, onclose }: { id: string | null; onclose: () => void } = $props();
	const { lab, ui } = useApp();
	// The editor is recreated for each record ({#key}), so reading props once is intended.
	const existing = untrack(() => (id ? lab.profile(id) : undefined));
	let name = $state(existing?.name ?? '');
	let age = $state<number | null>(existing?.age ?? null);
	let color = $state(existing?.color ?? 'violet');
	let interests = $state(existing?.interests ?? '');
	let kid = $state<KidLevel | ''>(existing?.kid ?? '');
	let busy = $state(false);
	let error = $state('');

	async function save() {
		busy = true;
		error = '';
		const body = {
			name,
			age: age === null || (age as unknown) === '' ? null : Number(age),
			color,
			interests,
			kid: kid || null
		};
		const ok = existing
			? await lab.call(
					'PATCH',
					`/api/profiles/${existing.id}`,
					{ ...body, version: existing.version },
					'Saved.'
				)
			: await lab.call('POST', '/api/profiles', body, `${name} joined the family.`);
		busy = false;
		if (ok) onclose();
	}
	async function remove() {
		if (!existing) return;
		if (lab.ws.projects.some((p) => p.profileId === existing.id))
			return (error = 'Reassign or delete this person’s projects before removing their profile.');
		if (!(await ui.ask('Remove this family profile?', 'This removes the saved profile.'))) return;
		if (await lab.call('DELETE', `/api/profiles/${existing.id}`, undefined, 'Profile removed.'))
			onclose();
	}
</script>

<EditorShell
	subject={name}
	id="profile-editor"
	eyebrow="THE MAKERS"
	title={existing ? 'Edit family profile' : 'Meet a new maker'}
	{busy}
	{error}
	saveLabel={existing ? 'Save changes' : 'Add person'}
	onsubmit={save}
	{onclose}
	ondelete={existing ? remove : undefined}
>
	<label class="field">Name or nickname<input bind:value={name} required maxlength="80" /></label>
	<div class="fields-row">
		<label class="field"
			>Age (optional)<input type="number" min="0" max="120" step="1" bind:value={age} /><small
				>Leave blank for an adult profile.</small
			></label
		>
		<label class="field"
			>Profile color<select bind:value={color}
				>{#each PROFILE_COLORS as c (c)}<option value={c}>{c}</option>{/each}</select
			></label
		>
	</div>
	<label class="field"
		>Kid mode<select bind:value={kid} disabled={!lab.ws.parentPin && !kid}>
			<option value="">Off: the full app</option>
			{#each KID_LEVELS as level (level)}<option value={level}>{KID_LEVEL_LABEL[level]}</option
				>{/each}
		</select><small
			>{#if lab.ws.parentPin}A simpler, safer space with big buttons and templates. Printing needs a
				grown-up’s yes, and leaving kid mode needs the parent PIN.{:else}Set a parent PIN on the <a
					href={resolve('/family')}>Family page</a
				> first.{/if}</small
		></label
	>
	<ExpandableText
		label="Interests & favorite colors"
		bind:value={interests}
		maxlength={500}
		hint="Used to suggest print ideas."
		ai={{
			actions: ['interests'],
			context: () => ({ Person: name, Age: age === null ? '' : String(age) })
		}}
	/>
</EditorShell>
