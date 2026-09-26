<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { decodeStl, makeThumbnail } from '$lib/client/models';
	import { kidTemplate } from '$lib/shared/kid';
	import KidViewer from '$lib/components/kid/KidViewer.svelte';

	const { lab, ui } = useApp();
	const kid = $derived(page.data.kid!);
	const little = $derived(kid.level === 'little');
	const template = $derived(kidTemplate(page.params.template ?? '', page.data.packTemplates));
	const usable = $derived(!!template?.levels.includes(kid.level));
	/** Colours on the shelf with enough left for a small print. */
	const colours = $derived(lab.ws.spools.filter((s) => s.remainingGrams >= 30));

	let values = $state<Record<string, string | number>>({});
	let spoolId = $state<string | null>(null);
	let mesh = $state<Float32Array | null>(null);
	let size = $state<[number, number, number] | null>(null);
	let busy = $state(false);
	let saving = $state(false);
	let problem = $state('');

	// Start from the template's defaults, with sizes inside this maker's range.
	$effect(() => {
		const t = template;
		const level = kid.level;
		if (!t) return;
		untrack(() => {
			const start: Record<string, string | number> = {};
			for (const c of t.controls) {
				const d = t.defaults[c.name];
				start[c.name] =
					c.kind === 'size'
						? Math.min(c.range[level][1], Math.max(c.range[level][0], Number(d)))
						: String(d ?? '');
			}
			values = start;
			spoolId = colours[0]?.id ?? null;
		});
	});

	// Live preview: waits for a pause in changes, and ignores answers that arrive out of order.
	let asked = 0;
	$effect(() => {
		const body = JSON.stringify({ template: template?.id, params: values });
		if (!template || !usable || !Object.keys(values).length) return;
		const n = ++asked;
		busy = true;
		const timer = setTimeout(async () => {
			try {
				const response = await fetch('/api/kid/preview', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body
				});
				const data = await response.json();
				if (n !== asked) return;
				if (!response.ok) {
					problem = data.error ?? 'That did not work. Try something else!';
					return;
				}
				problem = '';
				mesh = decodeStl(data.stl);
				size = data.size;
			} catch {
				if (n === asked) problem = 'Could not reach the app. Try again.';
			} finally {
				if (n === asked) busy = false;
			}
		}, 350);
		return () => clearTimeout(timer);
	});

	const cm = (mm: number) => (Math.round(mm / 5) / 2).toLocaleString();

	async function save() {
		if (!template || saving) return;
		saving = true;
		const made = await lab.call<{ projectId: string; modelId: string; versionId: string }>(
			'POST',
			'/api/kid/things',
			{ template: template.id, params: values }
		);
		if (!made) return (saving = false);
		// The picture shows the colour the child chose, here and on the grown-up's phone.
		await makeThumbnail(
			made.modelId,
			made.versionId,
			lab.spools.get(spoolId ?? '')?.colorHex ?? null
		);
		ui.toast('Saved! 🎉');
		const thing = resolve('/kid/things/[id]', { id: made.projectId });
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- a resolve() path plus the chosen colour
		await goto(spoolId ? `${thing}?spool=${encodeURIComponent(spoolId)}` : thing);
	}
</script>

<svelte:head><title>{template?.title ?? 'Make'} · Kid mode</title></svelte:head>

{#if !template || !usable}
	<h1 class="kid-title">That one is for older makers</h1>
	<a class="kid-button plain" href={resolve('/kid')}>← Pick another</a>
{:else}
	<h1 class="kid-title"><span aria-hidden="true">{template.icon}</span> {template.title}</h1>
	<div class="maker">
		<div class="maker-stage">
			<KidViewer
				{mesh}
				{busy}
				color={lab.spools.get(spoolId ?? '')?.colorHex ?? null}
				label="Your {template.title}, turning around"
			/>
			<p class="size" aria-live="polite">
				{#if problem}<span class="problem">{problem}</span>
				{:else if size && !little}About {cm(size[0])} × {cm(size[1])} cm, {cm(size[2])} cm tall
				{/if}
			</p>
		</div>
		<form
			class="controls"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			{#each template.controls as c (c.name)}
				{#if c.kind === 'text'}
					<label class="control">
						<span class="control-label">{c.label}</span>
						<input
							class="words"
							bind:value={values[c.name]}
							maxlength={c.max[kid.level]}
							placeholder={kid.name}
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
				{:else if c.kind === 'size'}
					<label class="control">
						<span class="control-label">{c.label}</span>
						<input
							type="range"
							min={c.range[kid.level][0]}
							max={c.range[kid.level][1]}
							step={c.step}
							bind:value={values[c.name]}
						/>
						<span class="ends" aria-hidden="true"
							><span>{c.ends[0]}</span><span>{c.ends[1]}</span></span
						>
					</label>
				{:else}
					<fieldset class="control">
						<legend class="control-label">{c.label}</legend>
						<div class="choices">
							{#each c.options as o (o.value)}
								<label class="choice" class:on={values[c.name] === o.value}>
									<input type="radio" name={c.name} value={o.value} bind:group={values[c.name]} />
									<span class="choice-icon" aria-hidden="true">{o.icon}</span>
									<span>{o.label}</span>
								</label>
							{/each}
						</div>
					</fieldset>
				{/if}
			{/each}
			{#if colours.length}
				<fieldset class="control">
					<legend class="control-label">Pick a colour</legend>
					<div class="colours">
						{#each colours as s (s.id)}
							<label class="colour" class:on={spoolId === s.id} title={s.colorName || s.material}>
								<input type="radio" name="colour" value={s.id} bind:group={spoolId} />
								<span class="dot" style:background={s.colorHex}></span>
								<span class="colour-name">{s.colorName || s.material}</span>
							</label>
						{/each}
					</div>
				</fieldset>
			{/if}
			<button class="kid-button" disabled={saving || busy || !!problem || !mesh}
				>{saving ? 'Saving…' : 'Save it! ✨'}</button
			>
		</form>
	</div>
{/if}

<style>
	.maker {
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
		gap: 28px;
		align-items: start;
	}
	.maker-stage {
		position: sticky;
		top: 16px;
	}
	.size {
		min-height: 28px;
		margin: 10px 4px 0;
		color: var(--k-muted);
		font-size: 16px;
		text-align: center;
	}
	.problem {
		color: #c22b52;
		font-weight: 650;
	}
	.controls {
		display: grid;
		gap: 18px;
	}
	.control {
		/* Fieldsets otherwise refuse to shrink below their content on narrow screens. */
		min-width: 0;
		display: grid;
		gap: 10px;
		margin: 0;
		padding: 18px 20px;
		border: 0;
		border-radius: 24px;
		background: var(--k-card);
		box-shadow: 0 5px 0 var(--k-line);
	}
	.control-label {
		padding: 0;
		font-size: 19px;
		font-weight: 750;
	}
	legend.control-label {
		float: left;
		width: 100%;
		margin-bottom: 10px;
	}
	.words {
		/* Inputs have a wide built-in size that would stretch the column on phones. */
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		min-height: 60px;
		padding: 8px 18px;
		border: 3px solid var(--k-line);
		border-radius: 18px;
		color: var(--k-ink);
		background: #fffdf9;
		font: 750 28px var(--sans);
	}
	.words:focus {
		border-color: var(--k-grape);
		outline: none;
	}
	input[type='range'] {
		width: 100%;
		height: 44px;
		accent-color: var(--k-berry);
		cursor: pointer;
	}
	.ends {
		display: flex;
		justify-content: space-between;
		margin-top: -8px;
		color: var(--k-muted);
		font-size: 15px;
		font-weight: 600;
	}
	.choices,
	.colours {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.choice,
	.colour {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		min-width: 86px;
		padding: 10px 12px;
		border-radius: 20px;
		background: #fbf4ea;
		box-shadow: inset 0 0 0 3px transparent;
		font-size: 15px;
		font-weight: 650;
		cursor: pointer;
	}
	.choice.on,
	.colour.on {
		background: #fff;
		box-shadow: inset 0 0 0 4px var(--k-grape);
	}
	.choice input,
	.colour input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.choice:has(input:focus-visible),
	.colour:has(input:focus-visible) {
		outline: 4px solid var(--k-focus);
		outline-offset: 3px;
	}
	.choice-icon {
		font-size: 34px;
		line-height: 1.2;
	}
	.dot {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 3px rgb(0 0 0 / 0.08);
	}
	.colour-name {
		max-width: 96px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.controls > .kid-button {
		margin-top: 6px;
	}
	@media (max-width: 800px) {
		.maker {
			grid-template-columns: minmax(0, 1fr);
		}
		.maker-stage {
			position: static;
		}
	}
</style>
