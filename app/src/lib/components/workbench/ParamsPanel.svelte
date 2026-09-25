<script lang="ts">
	import type { Parameter, ParamValues } from '$lib/shared/cad';

	let {
		parameters,
		values,
		onchange
	}: {
		parameters: Parameter[];
		values: ParamValues;
		onchange: (values: ParamValues) => void;
	} = $props();

	const groups = $derived(
		parameters.reduce<[string, Parameter[]][]>((acc, p) => {
			const g = acc.find((x) => x[0] === p.group);
			if (g) g[1].push(p);
			else acc.push([p.group, [p]]);
			return acc;
		}, [])
	);
	const valueOf = (p: Parameter) => (p.name in values ? values[p.name] : p.value);
	const changed = (p: Parameter) => p.name in values && values[p.name] !== p.value;
	const label = (name: string) => name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

	function set(p: Parameter, v: string | number | boolean) {
		const next = { ...values };
		if (v === p.value) delete next[p.name];
		else next[p.name] = v;
		onchange(next);
	}
	function reset(p: Parameter) {
		const next = { ...values };
		delete next[p.name];
		onchange(next);
	}
	const numberStep = (p: Parameter) =>
		p.step ??
		(Number.isInteger(p.value) && (p.max === undefined || p.max - (p.min ?? 0) > 10) ? 1 : 0.1);
</script>

{#if !parameters.length}
	<div class="params-empty">
		<p><strong>No adjustable parameters yet.</strong></p>
		<p>
			Variables at the top of the file, before the first module, become sliders here. Add a comment
			to set the range:
		</p>
		<pre><code
				>/* [Size] */
// Inner width in mm
width = 60; // [20:1:200]
style = "round"; // [round, square]</code
			></pre>
		<p>Or ask the AI to "add parameters for the main dimensions".</p>
	</div>
{:else}
	<div class="params">
		{#if Object.keys(values).length}
			<button class="mini reset-all" type="button" onclick={() => onchange({})}
				>Reset all to file defaults</button
			>
		{/if}
		{#each groups as [group, list] (group)}
			<fieldset>
				{#if groups.length > 1 || group !== 'Parameters'}<legend>{group}</legend>{/if}
				{#each list as p (p.name)}
					{@const v = valueOf(p)}
					<div class="param" class:changed={changed(p)}>
						<div class="param-head">
							<label for="param-{p.name}">{label(p.name)}</label>
							{#if changed(p)}<button
									class="mini icon"
									type="button"
									title="Back to {p.value}"
									onclick={() => reset(p)}>↺</button
								>{/if}
						</div>
						{#if p.type === 'number' && p.min !== undefined && p.max !== undefined}
							<div class="slider">
								<input
									type="range"
									min={p.min}
									max={p.max}
									step={numberStep(p)}
									value={v}
									oninput={(e) => set(p, +e.currentTarget.value)}
									aria-label={label(p.name)}
								/>
								<input
									id="param-{p.name}"
									class="num"
									type="number"
									min={p.min}
									max={p.max}
									step={numberStep(p)}
									value={v}
									onchange={(e) => e.currentTarget.value !== '' && set(p, +e.currentTarget.value)}
								/>
							</div>
						{:else if p.type === 'number'}
							<input
								id="param-{p.name}"
								class="num wide"
								type="number"
								step="any"
								value={v}
								onchange={(e) => e.currentTarget.value !== '' && set(p, +e.currentTarget.value)}
							/>
						{:else if p.type === 'boolean'}
							<label class="toggle"
								><input
									id="param-{p.name}"
									type="checkbox"
									checked={!!v}
									onchange={(e) => set(p, e.currentTarget.checked)}
								/><span>{v ? 'Yes' : 'No'}</span></label
							>
						{:else if p.type === 'choice' && p.options}
							{#if p.options.length <= 4}
								<div class="choices" role="radiogroup" aria-label={label(p.name)}>
									{#each p.options as o (o.value)}
										<button
											type="button"
											role="radio"
											aria-checked={v === o.value}
											onclick={() => set(p, o.value)}>{o.label}</button
										>
									{/each}
								</div>
							{:else}
								<select
									id="param-{p.name}"
									value={String(v)}
									onchange={(e) =>
										set(
											p,
											p.options!.find((o) => String(o.value) === e.currentTarget.value)!.value
										)}
								>
									{#each p.options as o (o.value)}<option value={String(o.value)}>{o.label}</option
										>{/each}
								</select>
							{/if}
						{:else}
							<input
								id="param-{p.name}"
								class="wide"
								value={String(v)}
								maxlength="1000"
								onchange={(e) => set(p, e.currentTarget.value)}
							/>
						{/if}
						{#if p.description}<small>{p.description}</small>{/if}
					</div>
				{/each}
			</fieldset>
		{/each}
	</div>
{/if}

<style>
	.params {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.reset-all {
		align-self: flex-end;
	}
	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	legend {
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--dim);
		margin-bottom: 8px;
		font-family: var(--mono);
	}
	.param {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding-left: 9px;
		border-left: 2px solid transparent;
	}
	.param.changed {
		border-left-color: var(--cyan);
	}
	.param-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		min-height: 22px;
	}
	.param-head label {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text-2);
	}
	.param small {
		color: var(--dim);
		font-size: 11.5px;
		line-height: 1.4;
	}
	.slider {
		display: grid;
		grid-template-columns: 1fr 76px;
		gap: 10px;
		align-items: center;
	}
	input[type='range'] {
		width: 100%;
		accent-color: var(--cyan);
	}
	.num,
	.wide,
	select {
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.03);
		padding: 5px 8px;
		font: 400 12.5px var(--mono);
		color: var(--text);
		min-width: 0;
		font-variant-numeric: tabular-nums;
	}
	.wide,
	select {
		width: 100%;
		font-family: var(--sans);
	}
	select option {
		background: var(--menu);
	}
	.num:focus,
	.wide:focus,
	select:focus {
		outline: none;
		border-color: rgb(var(--c1) / 0.65);
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.choices button {
		border: 0;
		border-radius: var(--r-sm);
		padding: 5px 10px;
		font-size: 12.5px;
		background: rgb(var(--hi) / 0.05);
		box-shadow: 0 0 0 1px var(--line) inset;
		color: var(--text-2);
	}
	.choices button[aria-checked='true'] {
		background: rgb(var(--c1) / 0.16);
		box-shadow: 0 0 0 1px rgb(var(--c1) / 0.55) inset;
		color: var(--text);
	}
	.toggle {
		display: inline-flex;
		gap: 8px;
		align-items: center;
		font-size: 12.5px;
		color: var(--text-2);
	}
	.toggle input {
		accent-color: var(--cyan);
		width: 16px;
		height: 16px;
	}
	.params-empty {
		font-size: 13px;
		color: var(--muted);
	}
	.params-empty p {
		margin: 0 0 8px;
	}
	.params-empty pre {
		margin: 0 0 10px;
		padding: 10px 12px;
		border-radius: var(--r-md);
		background: rgb(var(--hi) / 0.04);
		border: 1px solid var(--line);
		font-size: 12px;
		overflow-x: auto;
	}
</style>
