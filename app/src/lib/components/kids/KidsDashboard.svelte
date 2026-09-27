<script lang="ts">
	import { resolve } from '$app/paths';
	import { useApp } from '$lib/client/app.svelte';
	import { kidsFeed } from '$lib/client/modules/kids/feed.svelte';
	import { badgeInfo, type KidOverview, type KidsOverview } from '$lib/shared/kids';
	import Avatar from '../Avatar.svelte';
	import LimitsForm from './LimitsForm.svelte';
	import PhotoUpload from './PhotoUpload.svelte';

	// The parent's dashboard on the Family page: each child's limits and how much is used, badges,
	// requests against the limits, and finished prints waiting for a photo.
	const { lab } = useApp();
	const feed = kidsFeed<KidsOverview>(lab, () => '/api/kids');
	const data = $derived(feed.data);
	let editing = $state<string | null>(null);

	function meters(k: KidOverview) {
		const l = k.limits;
		const u = k.usage;
		return [
			{ label: 'Today', used: u.printsToday, limit: l.printsPerDay, unit: 'prints' },
			{ label: 'This week', used: u.printsThisWeek, limit: l.printsPerWeek, unit: 'prints' },
			{ label: 'Filament this week', used: u.gramsThisWeek, limit: l.gramsPerWeek, unit: 'g' },
			{ label: 'Filament this month', used: u.gramsThisMonth, limit: l.gramsPerMonth, unit: 'g' }
		].filter((m) => m.limit !== null) as {
			label: string;
			used: number;
			limit: number;
			unit: string;
		}[];
	}
</script>

<section class="panel kids-panel" aria-labelledby="kids-panel-title">
	<div class="panel-head">
		<h2 id="kids-panel-title">Kids at a glance</h2>
		<a class="ghost-button" href={resolve('/family/gallery')}>Family gallery →</a>
	</div>
	{#if feed.error}
		<p class="panel-empty">{feed.error}</p>
	{:else if !data}
		<p class="panel-empty">Loading…</p>
	{:else if !data.kids.length}
		<p class="panel-empty">
			Turn on kid mode for a child (✎ on their card) to set gentle limits and collect badges.
		</p>
	{:else}
		<div class="kids">
			{#each data.kids as k (k.profileId)}
				{@const p = lab.profile(k.profileId)}
				{@const ms = meters(k)}
				<article class="kid">
					<header>
						<Avatar profile={p} />
						<div>
							<h3>{p?.name ?? 'A kid'}</h3>
							<span class="facts"
								>{k.printsLastWeek} made this week · {k.galleryCount}
								{k.galleryCount === 1 ? 'photo' : 'photos'}</span
							>
						</div>
						<button
							class="mini"
							aria-expanded={editing === k.profileId}
							onclick={() => (editing = editing === k.profileId ? null : k.profileId)}
							>Limits</button
						>
					</header>
					{#if editing === k.profileId}
						<LimitsForm
							profileId={k.profileId}
							name={p?.name ?? 'this child'}
							limits={k.limits}
							ondone={() => (editing = null)}
						/>
					{:else if ms.length}
						<ul class="meters" aria-label="Limits used">
							{#each ms as m (m.label)}
								<li>
									<span class="meter-label">{m.label} <b>{m.used} / {m.limit} {m.unit}</b></span>
									<span
										class="meter"
										class:full={m.used >= m.limit}
										role="meter"
										aria-label={m.label}
										aria-valuemin={0}
										aria-valuemax={m.limit}
										aria-valuenow={m.used}
										><i style:width="{m.limit ? Math.min(100, (m.used / m.limit) * 100) : 100}%"
										></i></span
									>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="panel-empty">No limits set.</p>
					{/if}
					{#if k.limits.needApprovalOverGrams !== null && editing !== k.profileId}
						<p class="auto">Says yes by itself up to {k.limits.needApprovalOverGrams} g.</p>
					{/if}
					{#each k.recentRequests.filter((r) => r.check) as r (r.id)}
						<p class="request" class:over={!r.check?.ok}>
							Waiting: “{r.projectTitle}”, about {r.grams} g ·
							{r.check?.ok ? 'fits the limits' : r.check?.parentText}
						</p>
					{/each}
					<div class="badges" aria-label="Badges">
						{#each k.badges as b (b.badge)}
							{@const info = badgeInfo(b.badge)}
							{#if info}<span class="badge" title="{info.title}: {info.text}"
									><span aria-hidden="true">{info.icon}</span>
									<span class="sr-only">{info.title}</span></span
								>{/if}
						{:else}
							<span class="panel-empty">No badges yet.</span>
						{/each}
					</div>
				</article>
			{/each}
		</div>

		{#if data.photosWanted.length}
			<div class="wanted">
				<h3>Ready for the gallery</h3>
				<ul>
					{#each data.photosWanted as w (w.jobId)}
						<li>
							<span
								><strong>{lab.profile(w.profileId)?.name ?? 'A kid'}</strong> made {w.projectTitle}</span
							>
							<span class="wanted-actions">
								<PhotoUpload jobId={w.jobId} mini />
								{#if data.cameraAvailable}
									<button
										class="mini"
										onclick={() =>
											lab.call(
												'POST',
												`/api/kids/photos/${w.jobId}/capture`,
												{},
												'Photo added to the gallery.'
											)}>Printer camera</button
									>
								{/if}
								<button
									class="mini"
									onclick={() => lab.call('POST', `/api/kids/photos/${w.jobId}/dismiss`, {})}
									>No photo</button
								>
								<a class="mini" href={resolve('/family/certificate/[jobId]', { jobId: w.jobId })}
									>Certificate</a
								>
							</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<label class="camera-setting">
			<input
				type="checkbox"
				checked={data.settings.snapshots}
				disabled={!data.cameraAvailable}
				onchange={(e) =>
					lab.call('PATCH', '/api/kids/settings', { snapshots: e.currentTarget.checked })}
			/>
			<span
				>Take a photo with the printer camera when a kid’s print finishes
				{#if !data.cameraAvailable}<small>(needs a printer camera in Family Print Lab)</small
					>{/if}</span
			>
		</label>
	{/if}
</section>

<style>
	.kids-panel {
		display: grid;
		gap: 12px;
		margin: 0 0 22px;
	}
	.kids-panel .panel-head {
		margin: 0;
	}
	.kids-panel .panel-empty {
		margin: 0;
	}
	.ghost-button {
		text-decoration: none;
	}
	.kids {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
		gap: 12px;
	}
	.kid {
		display: grid;
		gap: 10px;
		align-content: start;
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: var(--panel-strong);
	}
	.kid header {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.kid header div {
		flex: 1;
		min-width: 0;
	}
	h3 {
		margin: 0;
		font-size: 15px;
	}
	.facts {
		display: block;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--muted);
		font-size: 12.5px;
	}
	.meters {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.meter-label {
		display: flex;
		justify-content: space-between;
		color: var(--muted);
		font-size: 12.5px;
	}
	.meter-label b {
		color: var(--text-2);
		font-weight: 550;
		font-variant-numeric: tabular-nums;
	}
	.meter {
		display: block;
		height: 6px;
		margin-top: 4px;
		border-radius: 999px;
		background: rgb(var(--hi) / 0.07);
		overflow: hidden;
	}
	.meter i {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--lime);
	}
	.meter.full i {
		background: var(--amber);
	}
	.auto,
	.request {
		margin: 0;
		color: var(--muted);
		font-size: 12.5px;
	}
	.request.over {
		color: var(--amber);
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.badge {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: rgb(var(--hi) / 0.06);
		font-size: 17px;
	}
	.wanted h3 {
		margin: 4px 0 8px;
	}
	.wanted ul {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.wanted li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 13.5px;
	}
	.wanted-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.wanted-actions a {
		text-decoration: none;
	}
	.camera-setting {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		color: var(--text-2);
		font-size: 13.5px;
	}
	.camera-setting small {
		color: var(--dim);
	}
</style>
