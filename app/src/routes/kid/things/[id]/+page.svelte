<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { thingStatus, thingTemplate } from '$lib/client/kid';
	import { loadMesh } from '$lib/client/models';
	import KidViewer from '$lib/components/kid/KidViewer.svelte';

	const { lab, ui } = useApp();
	const kid = $derived(page.data.kid!);
	const little = $derived(kid.level === 'little');
	const project = $derived(
		lab.ws.projects.find((p) => p.id === page.params.id && p.profileId === kid.id)
	);
	const made = $derived(project ? thingTemplate(lab, project) : null);
	const status = $derived(project ? thingStatus(lab, project.id, ui.now) : null);
	const colours = $derived(lab.ws.spools.filter((s) => s.remainingGrams >= 30));
	const QUICK = ['Please! 🙏', 'It’s a present 🎁', 'For school 🎒', 'For my room 🛏️'];

	let mesh = $state<Float32Array | null>(null);
	let spoolId = $state<string | null>(null);
	let message = $state('');
	let asking = $state(false);

	$effect(() => {
		const model = made?.model;
		if (!model?.currentVersionId) return;
		void loadMesh(model.id, model.currentVersionId)
			.then((m) => (mesh = m))
			.catch(() => (mesh = null));
	});
	// Start with the colour picked while making it; keep the child's choice while it is still on the shelf.
	$effect(() => {
		if (spoolId && colours.some((s) => s.id === spoolId)) return;
		const wanted = page.url.searchParams.get('spool');
		spoolId = colours.some((s) => s.id === wanted) ? wanted : (colours[0]?.id ?? null);
	});

	async function ask() {
		if (!project || asking) return;
		asking = true;
		const ok = await lab.call(
			'POST',
			`/api/kid/things/${project.id}/ask`,
			{ spoolId, message },
			'Asked! A grown-up will look soon. 🙋'
		);
		asking = false;
		if (ok) message = '';
	}
</script>

<svelte:head><title>{project?.title ?? 'My thing'} · Kid mode</title></svelte:head>

{#if !project || !status}
	<h1 class="kid-title">Hmm, that one is gone</h1>
	<a class="kid-button plain" href={resolve('/kid')}>← Back home</a>
{:else}
	<h1 class="kid-title">{project.title}</h1>
	<div class="thing">
		<KidViewer
			{mesh}
			color={lab.spools.get(status.request?.spoolId ?? spoolId ?? '')?.colorHex ?? null}
			progress={status.state === 'printing' ? status.progress : 1}
			label="Your {project.title}, turning around"
		/>
		<div class="thing-side">
			<section class="where {status.state}" aria-live="polite">
				<span class="where-icon" aria-hidden="true">{status.icon}</span>
				<div>
					<strong>{status.label}</strong>
					{#if status.progress !== null}
						<div
							class="kid-bar"
							role="progressbar"
							aria-label="Print progress"
							aria-valuenow={Math.round(status.progress * 100)}
						>
							<i style:width="{Math.round(status.progress * 100)}%"></i>
						</div>
					{/if}
					{#if status.request?.reply}
						<p class="reply">💬 “{status.request.reply}”</p>
					{/if}
				</div>
			</section>

			{#if status.canAsk}
				<form
					class="ask"
					onsubmit={(e) => {
						e.preventDefault();
						void ask();
					}}
				>
					<h2 class="kid-heading">
						{status.state === 'ready' ? 'Want it printed?' : 'Print it again?'}
					</h2>
					{#if colours.length}
						<fieldset>
							<legend>Which colour?</legend>
							<div class="colours">
								{#each colours as s (s.id)}
									<label
										class="colour"
										class:on={spoolId === s.id}
										title={s.colorName || s.material}
									>
										<input type="radio" name="colour" value={s.id} bind:group={spoolId} />
										<span class="dot" style:background={s.colorHex}></span>
										<span class="visually-hidden">{s.colorName || s.material}</span>
									</label>
								{/each}
							</div>
						</fieldset>
					{/if}
					<fieldset>
						<legend>Say something to the grown-up</legend>
						<div class="quick">
							{#each QUICK as q (q)}
								<button
									type="button"
									class="quick-chip"
									class:on={message === q}
									aria-pressed={message === q}
									onclick={() => (message = message === q ? '' : q)}>{q}</button
								>
							{/each}
						</div>
						{#if !little}
							<input
								class="note"
								bind:value={message}
								maxlength="200"
								placeholder="Or write your own message"
								aria-label="Your message"
							/>
						{/if}
					</fieldset>
					<button class="kid-button berry" disabled={asking}>🙋 Ask a grown-up to print it</button>
				</form>
			{/if}
			{#if made?.template}
				<a
					class="kid-button plain again"
					href={resolve('/kid/make/[template]', { template: made.template.id })}
					>{made.template.icon} Make another</a
				>
			{/if}
		</div>
	</div>
{/if}

<style>
	.thing {
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
		gap: 28px;
		align-items: start;
	}
	.thing-side {
		display: grid;
		gap: 18px;
	}
	.where {
		display: flex;
		gap: 16px;
		align-items: center;
		padding: 20px 22px;
		border-radius: 26px;
		background: var(--k-card);
		box-shadow: 0 5px 0 var(--k-line);
	}
	.where > div {
		flex: 1;
		display: grid;
		gap: 10px;
	}
	.where strong {
		font-size: 22px;
		letter-spacing: -0.02em;
	}
	.where-icon {
		font-size: 48px;
	}
	.where.made {
		background: #e2f8ec;
	}
	.where.waiting {
		background: #fff4d6;
	}
	.reply {
		margin: 0;
		font-size: 18px;
	}
	.ask {
		display: grid;
		gap: 14px;
		padding: 4px 22px 22px;
		border-radius: 26px;
		background: var(--k-card);
		box-shadow: 0 5px 0 var(--k-line);
	}
	.ask .kid-heading {
		margin: 14px 0 0;
	}
	fieldset {
		min-width: 0;
		display: grid;
		gap: 10px;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 8px;
		font-weight: 700;
	}
	.colours,
	.quick {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.colour {
		position: relative;
		padding: 5px;
		border-radius: 50%;
		cursor: pointer;
	}
	.colour.on {
		box-shadow: 0 0 0 4px var(--k-grape);
	}
	.colour input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.colour:has(input:focus-visible) {
		outline: 4px solid var(--k-focus);
		outline-offset: 3px;
	}
	.dot {
		display: block;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 3px rgb(0 0 0 / 0.08);
	}
	.quick-chip {
		min-height: 48px;
		padding: 8px 16px;
		border: 0;
		border-radius: 999px;
		color: var(--k-ink);
		background: #fbf4ea;
		font: 650 17px var(--sans);
		cursor: pointer;
	}
	.quick-chip.on {
		background: #fff;
		box-shadow: inset 0 0 0 3px var(--k-grape);
	}
	.note {
		/* Inputs have a wide built-in size that would stretch the column on phones. */
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		min-height: 54px;
		padding: 8px 16px;
		border: 3px solid var(--k-line);
		border-radius: 16px;
		color: var(--k-ink);
		background: #fffdf9;
		font: 600 18px var(--sans);
	}
	.note:focus {
		border-color: var(--k-grape);
		outline: none;
	}
	.again {
		justify-self: start;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
	@media (max-width: 800px) {
		.thing {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
