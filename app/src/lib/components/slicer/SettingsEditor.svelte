<script lang="ts">
	import type { ConfigMap, ConfigValue } from '$lib/shared/slicer/project';
	import {
		addableSettings,
		groupConfig,
		isSettingKey,
		settingDef,
		valueText
	} from '$lib/client/slicer/settings';

	// Settings changed for an object, a part or a height range, grouped like Bambu Studio's, with the
	// value the presets give as the placeholder. `keys`: offer only these (height ranges).
	let {
		config,
		defaults = {},
		keys = null,
		onset
	}: {
		config: ConfigMap;
		defaults?: ConfigMap;
		keys?: string[] | null;
		onset: (key: string, value: ConfigValue | undefined) => void;
	} = $props();

	const groups = $derived(groupConfig(config));
	const addable = $derived(
		addableSettings(config)
			.map((g) => ({ ...g, settings: g.settings.filter((s) => !keys || keys.includes(s.key)) }))
			.filter((g) => g.settings.length)
	);
	let adding = $state('');
	let raw = $state('');

	function add(key: string) {
		if (!key) return;
		if (!isSettingKey(key)) return;
		const d = settingDef(key);
		onset(key, valueText(defaults[key]) || (d.kind === 'bool' ? '1' : ''));
		adding = '';
		raw = '';
	}
</script>

<div class="se">
	{#each groups as g (g.page)}
		<div class="group">
			<span class="page">{g.page}</span>
			{#each g.keys as s (s.key)}
				<div class="setting">
					<label for="set-{s.key}">{s.label}</label>
					{#if s.kind === 'bool'}
						<input
							id="set-{s.key}"
							type="checkbox"
							checked={config[s.key] === '1' || config[s.key] === 'true'}
							onchange={(e) => onset(s.key, e.currentTarget.checked ? '1' : '0')}
						/>
					{:else}
						<input
							id="set-{s.key}"
							type="text"
							value={valueText(config[s.key])}
							placeholder={valueText(defaults[s.key]) || s.hint || ''}
							title={s.hint}
							onchange={(e) => onset(s.key, e.currentTarget.value.trim() || undefined)}
						/>
					{/if}
					<button
						class="icon-button"
						aria-label="Use the preset’s {s.label.toLowerCase()}"
						title="Use the preset’s value"
						onclick={() => onset(s.key, undefined)}>×</button
					>
				</div>
			{/each}
		</div>
	{/each}
	<div class="add">
		<select aria-label="Add a setting" bind:value={adding} onchange={() => add(adding)}>
			<option value="">+ Setting…</option>
			{#each addable as g (g.page)}
				<optgroup label={g.page}>
					{#each g.settings as s (s.key)}<option value={s.key}>{s.label}</option>{/each}
				</optgroup>
			{/each}
		</select>
		{#if !keys}
			<input
				type="text"
				placeholder="Other key, e.g. wall_generator"
				aria-label="Add another setting by its Bambu Studio name"
				bind:value={raw}
				onkeydown={(e) => e.key === 'Enter' && add(raw.trim())}
			/>
		{/if}
	</div>
</div>

<style>
	.se {
		display: grid;
		gap: 8px;
	}
	.group {
		display: grid;
		gap: 4px;
	}
	.page {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--dim);
	}
	.setting {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
		gap: 6px;
		align-items: center;
		font-size: 12.5px;
	}
	.setting input[type='text'] {
		min-width: 0;
	}
	.setting input[type='checkbox'] {
		justify-self: start;
	}
	.add {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.add select,
	.add input {
		flex: 1;
		min-width: 120px;
	}
</style>
