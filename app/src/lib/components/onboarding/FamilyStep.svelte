<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { KID_LEVEL_LABEL, KID_LEVELS, PROFILE_COLORS, type KidLevel } from '$lib/shared/domain';
	import Avatar from '$lib/components/Avatar.svelte';

	// Setup guide, family step: a profile per person, kid mode for children, and the parent PIN that
	// kid mode needs (asked for right here the first time a child gets kid mode).
	const { lab } = useApp();
	const profiles = $derived(lab.ws.profiles);

	let name = $state('');
	let age = $state<number | null>(null);
	let color = $state<(typeof PROFILE_COLORS)[number]>('violet');
	let kid = $state<KidLevel | ''>('');
	let pin = $state('');
	let confirm = $state('');
	let error = $state('');
	let busy = $state(false);
	const needPin = $derived(!!kid && !lab.ws.parentPin);

	// A different colour for each new person, while there are colours left.
	$effect(() => {
		const used = new Set(profiles.map((p) => p.color));
		color = PROFILE_COLORS.find((c) => !used.has(c)) ?? 'violet';
	});

	async function add(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (needPin) {
			if (!/^\d{4,8}$/.test(pin)) return (error = 'Use 4 to 8 digits for the parent PIN.');
			if (pin !== confirm) return (error = 'The two PINs are different.');
		}
		busy = true;
		try {
			if (needPin && !(await lab.call('POST', '/api/parent/pin', { pin }, 'Parent PIN set.')))
				return;
			const who = name.trim();
			const ok = await lab.call(
				'POST',
				'/api/profiles',
				{
					name: who,
					age: age === null || (age as unknown) === '' ? null : Number(age),
					color,
					kid: kid || null
				},
				`${who} joined the family.`
			);
			if (ok) {
				name = '';
				age = null;
				kid = '';
				pin = confirm = '';
			}
		} finally {
			busy = false;
		}
	}
</script>

<div class="step-body">
	<p class="lead">
		Each person gets their own projects and ideas. Children can have <strong>kid mode</strong>: big
		buttons and templates, printing only after a grown-up says yes, and a parent PIN to leave it.
	</p>

	{#if profiles.length}
		<ul class="people" aria-label="Family profiles">
			{#each profiles as p (p.id)}
				<li>
					<Avatar profile={p} />
					<span>{p.name}</span>
					{#if p.kid}<small>{KID_LEVEL_LABEL[p.kid]}</small>{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<form class="person" onsubmit={add} aria-label="Add a person">
		<div class="fields-row">
			<label class="field"
				>Name or nickname<input bind:value={name} required maxlength="80" /></label
			>
			<label class="field"
				>Age (optional)<input type="number" min="0" max="120" step="1" bind:value={age} /></label
			>
		</div>
		<div class="fields-row">
			<label class="field"
				>Profile colour<select bind:value={color}
					>{#each PROFILE_COLORS as c (c)}<option value={c}>{c}</option>{/each}</select
				></label
			>
			<label class="field"
				>Kid mode<select bind:value={kid}>
					<option value="">Off: the full app</option>
					{#each KID_LEVELS as level (level)}<option value={level}>{KID_LEVEL_LABEL[level]}</option
						>{/each}
				</select></label
			>
		</div>
		{#if needPin}
			<div class="pin">
				<p>
					Kid mode needs a parent PIN, so only grown-ups can leave it. Pick 4 to 8 digits you will
					remember.
				</p>
				<div class="fields-row">
					<label class="field"
						>Parent PIN<input
							type="password"
							inputmode="numeric"
							autocomplete="new-password"
							maxlength="8"
							bind:value={pin}
							required
						/></label
					>
					<label class="field"
						>PIN again<input
							type="password"
							inputmode="numeric"
							autocomplete="new-password"
							maxlength="8"
							bind:value={confirm}
							required
						/></label
					>
				</div>
			</div>
		{/if}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<div class="row">
			<button class="primary" disabled={busy || !name.trim()}>Add person</button>
		</div>
	</form>
</div>

<style>
	.step-body {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.lead {
		margin: 0;
		color: var(--text-2);
		font-size: 13.5px;
	}
	.people {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.people li {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px 6px 6px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--panel);
		font-size: 13px;
	}
	.people small {
		color: var(--dim);
		font-size: 11.5px;
	}
	.person {
		padding: 14px 16px;
		border-radius: var(--r-lg);
		border: 1px solid var(--line);
		background: var(--panel);
	}
	.pin {
		padding: 10px 12px 0;
		margin-bottom: 12px;
		border-radius: var(--r-md);
		background: rgb(var(--c2) / 0.08);
	}
	.pin p {
		margin: 0 0 10px;
		font-size: 12.5px;
		color: var(--text-2);
	}
	.error {
		margin: 0 0 10px;
		color: var(--err-text);
		font-size: 12.5px;
	}
	.row {
		display: flex;
		gap: 8px;
	}
</style>
