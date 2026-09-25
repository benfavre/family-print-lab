<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { useApp } from '$lib/client/app.svelte';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import { PROJECT_STATUSES, type Profile } from '$lib/shared/domain';
	import { duration, weight } from '$lib/client/format';
	import { projectHref } from '$lib/client/actions';
	import { fileUrl, modelHref } from '$lib/client/models';

	const { lab, ui } = useApp();
	const made = $derived(lab.ws.projects.filter((p) => p.status === 'Done').length);

	/** Everything the card shows about one maker. */
	function maker(p: Profile) {
		const projects = lab.ws.projects.filter((x) => x.profileId === p.id);
		const ids = new Set(projects.map((x) => x.id));
		const jobs = lab.ws.jobs.filter((j) => ids.has(j.projectId));
		const good = jobs.filter((j) => j.status === 'Succeeded').length;
		const bad = jobs.filter((j) => j.status === 'Failed').length;
		const finished = jobs.filter((j) => j.status === 'Succeeded' || j.status === 'Failed');
		const now =
			projects.find((x) => x.status === 'Printing') ??
			[...projects]
				.filter((x) => x.status === 'Planned')
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
			[...projects]
				.filter((x) => x.status === 'Idea')
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
		const models = lab.ws.models
			.filter((m) => ids.has(m.projectId))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map((m) => ({ m, v: m.versions.find((v) => v.id === m.currentVersionId) }))
			.filter((x) => x.v?.hasThumbnail)
			.slice(0, 4);
		return {
			projects,
			done: projects.filter((x) => x.status === 'Done').length,
			byStatus: PROJECT_STATUSES.map((s) => ({
				s,
				n: projects.filter((x) => x.status === s).length
			})),
			prints: jobs.length,
			rate: good + bad ? Math.round((good / (good + bad)) * 100) : null,
			grams: finished.reduce((t, j) => t + (j.grams ?? 0), 0),
			minutes: finished.reduce((t, j) => t + (j.actualMinutes ?? j.minutes ?? 0), 0),
			now,
			models
		};
	}
</script>

<svelte:head><title>Family · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		<PageHero
			eyebrow="EVERYONE HAS A LITTLE MAKER IN THEM"
			title="Meet the makers"
			text="Their favorites, their ideas, their next thing to make."
			note="Preview animation"
		>
			{#snippet actions()}<button class="primary" onclick={() => ui.openEditor('profile')}
					>＋ Add person</button
				>{/snippet}
			{#snippet extra()}
				<StatTiles
					label="Family totals"
					items={[
						{ label: 'Makers', value: lab.ws.profiles.length, p: 1, tone: 'Idea' },
						{ label: 'Ideas', value: lab.ws.projects.length, p: 1, tone: 'Planned' },
						{ label: 'Prints', value: lab.ws.jobs.length, p: 1, tone: 'Printing' },
						{
							label: 'Made',
							value: made,
							p: lab.ws.projects.length ? made / lab.ws.projects.length : 0,
							tone: 'Done'
						}
					]}
				/>
			{/snippet}
		</PageHero>
		<div class="section-meta">
			<span></span><span>Profiles organize projects; they are not separate logins</span>
		</div>
		<div class="project-grid family-grid">
			{#each lab.ws.profiles as p (p.id)}
				{@const m = maker(p)}
				<article class="project-card family-card {p.color}-glow">
					<div class="maker-top">
						<div class="ring" style:--p={m.projects.length ? m.done / m.projects.length : 0}>
							<Avatar profile={p} />
						</div>
						<div class="maker-name">
							<h2>{p.name}</h2>
							<span class="profile-count"
								>{p.age === null ? 'Adult' : `Age ${p.age}`} · {m.projects.length} projects · {m.done}
								made</span
							>
						</div>
						<button
							class="mini icon edit"
							aria-label="Edit {p.name}"
							title="Edit profile"
							onclick={() => ui.openEditor('profile', p.id)}>✎</button
						>
					</div>
					{#if m.projects.length}
						<div class="status-bar" aria-label="Projects by progress">
							{#each m.byStatus as b (b.s)}{#if b.n}<span
										class="seg s-{b.s}"
										style:flex={b.n}
										title="{b.n} {b.s}"
									></span>{/if}{/each}
						</div>
					{/if}
					<p class="interests">
						{p.interests || 'Add favorite colors, interests, or things they would love to make.'}
					</p>
					{#if m.now}
						<a class="now" href={projectHref(m.now.id)}
							><span class="now-label"
								>{m.now.status === 'Printing'
									? 'Printing'
									: m.now.status === 'Planned'
										? 'Up next'
										: 'Idea'}</span
							>{m.now.title}</a
						>
					{/if}
					{#if m.models.length}
						<div class="maker-models">
							{#each m.models as { m: model, v } (model.id)}
								<a href={modelHref(model.projectId, model.id)} title={model.name}
									><img
										src={fileUrl(model.id, v!.id, 'thumbnail.png')}
										alt={model.name}
										loading="lazy"
									/></a
								>
							{/each}
						</div>
					{/if}
					<dl class="maker-stats">
						<div>
							<dt>Prints</dt>
							<dd>{m.prints}</dd>
						</div>
						<div>
							<dt>Success</dt>
							<dd>{m.rate === null ? '—' : `${m.rate}%`}</dd>
						</div>
						<div>
							<dt>Filament</dt>
							<dd>{weight(m.grams)}</dd>
						</div>
						<div>
							<dt>Time</dt>
							<dd>{duration(m.minutes)}</dd>
						</div>
					</dl>
					<div class="card-buttons">
						<button
							class="secondary"
							onclick={() => ui.openEditor('project', null, { profileId: p.id })}
							>＋ New idea</button
						>
						<button
							class="secondary ai"
							onclick={() => ui.assistantTask?.('ideas', { profileId: p.id })}>✦ Ideas</button
						>
						<button
							class="secondary"
							onclick={() => (
								(ui.profile = p.id),
								(ui.status = 'All'),
								(ui.query = ''),
								goto(resolve('/'))
							)}>Projects →</button
						>
					</div>
				</article>
			{:else}
				<div class="empty">
					<h2>Who is making?</h2>
					<p>Add your first family profile.</p>
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.maker-top,
	.status-bar,
	.now,
	.maker-models,
	.maker-stats,
	.interests {
		align-self: stretch;
	}
	.maker-top {
		display: flex;
		align-items: center;
		gap: 14px;
	}
	.maker-top .ring {
		margin-bottom: 0;
	}
	.maker-name {
		flex: 1;
		min-width: 0;
	}
	.maker-name h2 {
		margin: 0 0 2px;
	}
	.edit {
		align-self: flex-start;
	}
	.status-bar {
		display: flex;
		gap: 2px;
		height: 5px;
		margin: 12px 0 4px;
		border-radius: 999px;
		overflow: hidden;
	}
	.seg {
		min-width: 4px;
	}
	.seg.s-Idea {
		background: var(--idea);
	}
	.seg.s-Planned {
		background: var(--planned);
	}
	.seg.s-Printing {
		background: var(--printing);
	}
	.seg.s-Done {
		background: var(--done);
	}
	.interests {
		margin: 8px 0;
	}
	.now {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: rgb(var(--hi) / 0.025);
		color: var(--text);
		text-decoration: none;
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition: border-color 0.15s;
	}
	.now:hover {
		border-color: rgb(var(--c1) / 0.5);
	}
	.now-label {
		flex-shrink: 0;
		font: 500 10.5px var(--mono);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--cyan);
	}
	.maker-models {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
		margin-top: 10px;
	}
	.maker-models a {
		aspect-ratio: 4 / 3;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid var(--line);
		background: var(--panel-strong);
		transition:
			border-color 0.15s,
			transform 0.15s;
	}
	.maker-models a:hover {
		border-color: rgb(var(--c1) / 0.6);
		transform: translateY(-1px);
	}
	.maker-models img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.maker-stats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
		margin: 12px 0;
	}
	.maker-stats div {
		padding: 6px 8px;
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.03);
		border: 1px solid var(--line);
	}
	.maker-stats dt {
		font-size: 10.5px;
		color: var(--dim);
	}
	.maker-stats dd {
		margin: 2px 0 0;
		font-size: 13.5px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
</style>
