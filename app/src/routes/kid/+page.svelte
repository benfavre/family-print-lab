<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import { thingStatus, thingTemplate, thumbZoom } from '$lib/client/kid';
	import { fileUrl, makeThumbnail } from '$lib/client/models';
	import { templatesFor } from '$lib/shared/kid';

	const { lab, ui } = useApp();
	const kid = $derived(page.data.kid!);
	const little = $derived(kid.level === 'little');
	const templates = $derived(templatesFor(kid.level, page.data.packTemplates));
	const things = $derived(
		lab.ws.projects
			.filter((p) => p.profileId === kid.id)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((p) => {
				const { model, template } = thingTemplate(lab, p, page.data.packTemplates);
				const version = model?.versions.find((v) => v.id === model.currentVersionId);
				return { p, model, version, template, status: thingStatus(lab, p.id, ui.now) };
			})
	);
	const printing = $derived(things.find((t) => t.status.state === 'printing'));

	// Things saved before their picture was made get one now (quietly; the icon stands in meanwhile).
	onMount(() => {
		for (const t of things)
			if (t.model && t.version && !t.version.hasThumbnail)
				void makeThumbnail(t.model.id, t.version.id);
	});
</script>

<svelte:head><title>Kid mode · Family Print Lab</title></svelte:head>

{#if printing}
	<section class="now-printing" aria-live="polite">
		<span class="big" aria-hidden="true">🖨️</span>
		<div>
			<strong>The printer is making your {printing.p.title}!</strong>
			{#if printing.status.progress !== null}
				<div
					class="kid-bar"
					role="progressbar"
					aria-label="Print progress"
					aria-valuenow={Math.round(printing.status.progress * 100)}
				>
					<i style:width="{Math.round(printing.status.progress * 100)}%"></i>
				</div>
			{/if}
		</div>
	</section>
{/if}

<h1 class="kid-title">{little ? 'What shall we make?' : 'What do you want to make today?'}</h1>
<div class="templates">
	{#each templates as t (t.id)}
		<a class="template" href={resolve('/kid/make/[template]', { template: t.id })}>
			<span class="icon" aria-hidden="true">{t.icon}</span>
			<strong>{t.title}</strong>
			{#if !little}<span class="blurb">{t.blurb}</span>{/if}
		</a>
	{/each}
</div>

<h2 class="kid-heading">My things</h2>
{#if things.length}
	<div class="things">
		{#each things as t (t.p.id)}
			<a class="thing" href={resolve('/kid/things/[id]', { id: t.p.id })}>
				<span class="picture">
					{#if t.model && t.version?.hasThumbnail}
						<img
							src={fileUrl(t.model.id, t.version.id, 'thumbnail.webp')}
							alt=""
							style:transform="scale({thumbZoom(t.version)})"
						/>
					{:else}
						<span aria-hidden="true">{t.template?.icon ?? '✨'}</span>
					{/if}
				</span>
				<strong>{t.p.title}</strong>
				<span class="kid-status {t.status.state}"
					><span aria-hidden="true">{t.status.icon}</span>{t.status.label}</span
				>
			</a>
		{/each}
	</div>
{:else}
	<p class="no-things">Things you make will show up here. Pick one above to start!</p>
{/if}

<style>
	.now-printing {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 18px 22px;
		margin-bottom: 8px;
		border-radius: 26px;
		background: #e3f3ff;
		box-shadow: 0 5px 0 #c7e3fb;
	}
	.now-printing > div {
		flex: 1;
		display: grid;
		gap: 10px;
	}
	.big {
		font-size: 42px;
	}
	.templates {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 16px;
	}
	.template {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 22px;
		border-radius: 28px;
		color: inherit;
		background: var(--k-card);
		box-shadow: 0 6px 0 var(--k-line);
		text-decoration: none;
		transition: transform 0.15s;
	}
	.template:hover {
		transform: translateY(-3px) rotate(-0.6deg);
	}
	.template:active {
		transform: translateY(3px);
		box-shadow: 0 2px 0 var(--k-line);
	}
	.template .icon {
		font-size: 54px;
		line-height: 1.1;
	}
	.template strong {
		font-size: 22px;
		letter-spacing: -0.02em;
	}
	.blurb {
		color: var(--k-muted);
		font-size: 16px;
	}
	:global(.little) .template {
		align-items: center;
		text-align: center;
	}
	:global(.little) .template .icon {
		font-size: 76px;
	}
	.things {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
		gap: 16px;
	}
	.thing {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 12px 16px;
		border-radius: 26px;
		color: inherit;
		background: var(--k-card);
		box-shadow: 0 6px 0 var(--k-line);
		text-decoration: none;
	}
	.thing strong {
		padding: 0 6px;
		font-size: 18px;
	}
	.thing .kid-status {
		align-self: flex-start;
		margin: 0 4px;
	}
	.picture {
		display: grid;
		place-items: center;
		aspect-ratio: 4 / 3;
		border-radius: 18px;
		background: #fdf1e2;
		font-size: 60px;
		overflow: hidden;
	}
	.picture img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transform-origin: 50% 52%;
	}
	.no-things {
		padding: 24px;
		border-radius: 24px;
		background: rgb(255 255 255 / 0.6);
		color: var(--k-muted);
	}
	@media (prefers-reduced-motion: reduce) {
		.template {
			transition: none;
		}
	}
</style>
