<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { money, stamp, weight } from '$lib/client/format';
	import { projectHref } from '$lib/client/actions';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import type { Spool } from '$lib/shared/domain';

	const { lab, ui } = useApp();

	// ---------- Finding spools ----------
	let query = $state('');
	let material = $state('All');
	let sort = $state<'left' | 'most' | 'recent' | 'name'>('left');
	const materials = $derived(['All', ...new Set(lab.ws.spools.map((s) => s.material))]);
	const lastUsed = (s: Spool) =>
		lab.ws.jobs
			.filter((j) => j.spoolId === s.id && j.finishedAt)
			.reduce((m, j) => (j.finishedAt! > m ? j.finishedAt! : m), '');
	const shown = $derived(
		[...lab.ws.spools]
			.filter((s) => material === 'All' || s.material === material)
			.filter((s) => {
				const q = query.trim().toLowerCase();
				return (
					!q ||
					`${s.colorName} ${s.brand} ${s.material} ${s.notes} ${s.colorHex}`
						.toLowerCase()
						.includes(q)
				);
			})
			.sort((a, b) =>
				sort === 'name'
					? `${a.colorName}${a.material}`.localeCompare(`${b.colorName}${b.material}`)
					: sort === 'recent'
						? lastUsed(b).localeCompare(lastUsed(a))
						: sort === 'most'
							? b.remainingGrams / b.totalGrams - a.remainingGrams / a.totalGrams
							: a.remainingGrams / a.totalGrams - b.remainingGrams / b.totalGrams
			)
	);

	// ---------- Matching spools to what is loaded in the printer's AMS ----------
	const hexToRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
	const near = (a: string, b: string) => {
		const [x, y] = [hexToRgb(a), hexToRgb(b)];
		return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 60;
	};
	const trays = $derived(
		(lab.printer.state?.ams ?? []).flatMap((u) =>
			u.trays.filter((t) => t.type && t.color).map((t) => ({ ...t, unit: u.unit }))
		)
	);
	const inAms = (s: Spool) =>
		trays.find(
			(t) =>
				t.type.toUpperCase() === s.material.toUpperCase() &&
				near(`#${t.color!.replace('#', '').slice(0, 6)}`, s.colorHex)
		);

	// ---------- Quick weigh-in and usage ----------
	let weighing = $state<string | null>(null);
	let grams = $state(0);
	let open = $state<string | null>(null);
	const focusSelect = (node: HTMLInputElement) => {
		node.focus();
		node.select();
	};
	async function saveWeight(s: Spool) {
		const value = Math.max(0, Math.min(s.totalGrams, Math.round(grams)));
		const ok = await lab.call(
			'PATCH',
			`/api/spools/${s.id}`,
			{ version: s.version, remainingGrams: value },
			`${s.colorName || s.material}: ${weight(value)} left.`
		);
		if (ok) weighing = null;
	}
	const spools = $derived(lab.ws.spools);
	const total = $derived(spools.reduce((s, x) => s + x.totalGrams, 0));
	const onHand = $derived(spools.reduce((s, x) => s + x.remainingGrams, 0));
	const isLow = (s: Spool) => s.remainingGrams / s.totalGrams < 0.15 || s.remainingGrams < 100;
	const low = $derived(spools.filter(isLow));
	const used = $derived(
		lab.ws.jobs
			.filter((j) => j.spoolId && (j.status === 'Succeeded' || j.status === 'Failed'))
			.reduce((s, j) => s + (j.grams ?? 0), 0)
	);
</script>

<svelte:head><title>Filament · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		<PageHero
			eyebrow="MATERIALS"
			title="Filament shelf"
			text="Track what is on the shelf. Finished prints deduct from the spool you choose, so you know before a job runs out."
			note="Preview animation"
		>
			{#snippet actions()}<button class="primary" onclick={() => ui.openEditor('spool')}
					>＋ Add spool</button
				>{/snippet}
			{#snippet extra()}
				<StatTiles
					label="Filament totals"
					items={[
						{ label: 'Spools', value: spools.length, p: 1, tone: 'Planned' },
						{
							label: 'On hand',
							value: weight(onHand),
							p: total ? onHand / total : 0,
							tone: 'Done'
						},
						{
							label: 'Low stock',
							value: low.length,
							p: spools.length ? low.length / spools.length : 0,
							tone: 'Printing'
						},
						{ label: 'Used', value: weight(used), p: total ? used / total : 0, tone: 'Idea' }
					]}
				/>
			{/snippet}
		</PageHero>
		{#if low.length}
			<div class="low-banner" role="status">
				<span class="low-dot" aria-hidden="true"></span>
				<span
					><b>Running low:</b>
					{low
						.map((s) => `${s.colorName || s.colorHex} ${s.material} (${weight(s.remainingGrams)})`)
						.join(' · ')}</span
				>
			</div>
		{/if}
		<div class="shelf-toolbar">
			<label class="search"
				><span aria-hidden="true">⌕</span><input
					type="search"
					bind:value={query}
					placeholder="Search colours, brands, notes…"
					aria-label="Search spools"
				/></label
			>
			{#if materials.length > 2}
				<div class="status-tabs" role="group" aria-label="Material">
					{#each materials as m (m)}
						<button
							class="status-tab"
							class:selected={material === m}
							aria-pressed={material === m}
							onclick={() => (material = m)}
							>{m}{#if m !== 'All'}<span
									>{lab.ws.spools.filter((s) => s.material === m).length}</span
								>{/if}</button
						>
					{/each}
				</div>
			{/if}
			<label class="sort"
				>Sort <select bind:value={sort} aria-label="Sort spools">
					<option value="left">Least left first</option>
					<option value="most">Most left first</option>
					<option value="recent">Recently used</option>
					<option value="name">Name</option>
				</select></label
			>
			<span class="meta-note">Weights are what you record — the app does not weigh spools</span>
		</div>
		<div class="project-grid spool-grid">
			{#each shown as s (s.id)}
				{@const p = s.remainingGrams / s.totalGrams}
				{@const jobs = lab.ws.jobs
					.filter((j) => j.spoolId === s.id)
					.sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))}
				{@const tray = inAms(s)}
				<article class="project-card spool-card" class:low={isLow(s)} style:--swatch={s.colorHex}>
					<div class="spool-visual">
						<div class="spool" style:--swatch={s.colorHex} style:--p={p} aria-hidden="true">
							<span class="hub"></span>
						</div>
					</div>
					<div class="card-body">
						<div class="spool-head">
							<h2>{s.colorName || s.colorHex}</h2>
							{#if isLow(s)}<StatusPill status="Failed" label="Low stock" />{/if}
						</div>
						<p class="spool-sub">{[s.brand, s.material].filter(Boolean).join(' · ')}</p>
						{#if tray}
							<p class="in-ams" title="Matched by material and colour to what the printer reports">
								<span class="ams-dot" aria-hidden="true"></span>In AMS {Number(tray.unit) + 1} · slot
								{Number(tray.slot) + 1}{tray.remain !== null
									? ` · printer says ${tray.remain}%`
									: ''}{tray.active ? ' · in use' : ''}
							</p>
						{/if}
						<div class="meter"><span class="bar" style:--p={p}></span></div>
						<div class="spool-figures">
							<span><strong>{weight(s.remainingGrams)}</strong> left of {weight(s.totalGrams)}</span
							><span>{Math.round(p * 100)}%</span>
						</div>
						{#if weighing === s.id}
							<form
								class="weigh"
								onsubmit={(e) => {
									e.preventDefault();
									void saveWeight(s);
								}}
							>
								<input
									type="number"
									min="0"
									max={s.totalGrams}
									step="1"
									bind:value={grams}
									aria-label="Grams left on {s.colorName}"
									onkeydown={(e) => e.key === 'Escape' && (weighing = null)}
									use:focusSelect
								/><span>g</span>
								<button class="mini primary-mini">Save</button>
								<button type="button" class="mini" onclick={() => (weighing = null)}>Cancel</button>
							</form>
						{/if}
						<p class="spool-sub">
							{s.cost !== null
								? `${money((s.cost * 1000) / s.totalGrams)} per kg`
								: 'No price recorded'}
						</p>
						{#if s.notes}<p class="spool-notes">{s.notes}</p>{/if}
						{#if jobs.length}
							<button
								type="button"
								class="usage-toggle"
								aria-expanded={open === s.id}
								onclick={() => (open = open === s.id ? null : s.id)}
								>{open === s.id ? '▾' : '▸'}
								{jobs.length}
								{jobs.length === 1 ? 'print' : 'prints'} used this spool</button
							>
							{#if open === s.id}
								<ul class="usage">
									{#each jobs as j (j.id)}
										{@const project = lab.project(j.projectId)}
										{@const cost = lab.jobCost(j)}
										<li>
											<span class="u-dot s-{j.status}" aria-hidden="true"></span>
											{#if project}<a href={projectHref(project.id)}>{project.title}</a>{/if}
											<span class="u-meta"
												>{j.grams !== null ? weight(j.grams) : '—'}{cost !== null
													? ` · ${money(cost)}`
													: ''} · {stamp(j.finishedAt ?? j.createdAt)}</span
											>
										</li>
									{/each}
								</ul>
							{/if}
						{/if}
					</div>
					<div class="card-footer">
						<span class="card-person"
							><span class="swatch" style:--swatch={s.colorHex} aria-hidden="true"></span><span
								>{s.colorHex.toUpperCase()}</span
							></span
						>
						<span class="footer-actions">
							<button
								class="open-project"
								onclick={() => {
									weighing = s.id;
									grams = s.remainingGrams;
								}}
								title="Enter what is left on the spool">Weigh</button
							>
							<button class="open-project" onclick={() => ui.openEditor('spool', s.id)}>Edit</button
							>
						</span>
					</div>
				</article>
			{:else}
				<div class="empty">
					{#if lab.ws.spools.length}
						<h2>No spools match</h2>
						<p>Try another material or search.</p>
					{:else}
						<h2>The shelf is empty</h2>
						<p>
							Add the spools you own to track what is left and what each print costs. Spools loaded
							in the printer's AMS can be added from the Printer page.
						</p>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.low-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 4px 0 12px;
		padding: 10px 14px;
		border-radius: var(--r-md);
		border: 1px solid rgb(var(--c4) / 0.4);
		background: rgb(var(--c4) / 0.07);
		font-size: 13px;
		color: var(--text-2);
	}
	.low-banner b {
		color: var(--amber);
		font-weight: 600;
	}
	.low-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--amber);
		flex-shrink: 0;
	}
	.shelf-toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin: 4px 0 14px;
	}
	.shelf-toolbar .search {
		width: min(320px, 100%);
	}
	.sort {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--muted);
	}
	.sort select {
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		padding: 5px 8px;
		font: inherit;
	}
	.sort select option {
		background: var(--menu);
	}
	.meta-note {
		margin-left: auto;
		font-size: 12px;
		color: var(--dim);
	}
	.spool-card.low {
		border-color: rgb(var(--c4) / 0.45);
	}
	.in-ams {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 2px 0 6px;
		font-size: 12px;
		color: var(--lime);
	}
	.ams-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--lime);
		box-shadow: 0 0 6px rgb(var(--c3) / 0.7);
	}
	.weigh {
		flex-wrap: nowrap;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 6px 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.weigh input {
		width: 76px;
		min-width: 0;
		border: 1px solid rgb(var(--c1) / 0.6);
		border-radius: var(--r-sm);
		background: rgb(var(--hi) / 0.04);
		color: var(--text);
		padding: 5px 8px;
		font: 500 13px var(--mono);
	}
	.usage-toggle {
		border: 0;
		background: transparent;
		padding: 4px 0;
		font-size: 12px;
		color: var(--cyan);
		text-align: left;
	}
	.usage {
		list-style: none;
		margin: 2px 0 4px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 5px;
		font-size: 12px;
	}
	.usage li {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}
	.usage a {
		color: var(--text-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.u-meta {
		margin-left: auto;
		color: var(--dim);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.u-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--dim);
	}
	.u-dot.s-Succeeded {
		background: var(--lime);
	}
	.u-dot.s-Failed {
		background: var(--red);
	}
	.u-dot.s-Printing {
		background: var(--amber);
	}
	.footer-actions {
		display: flex;
		gap: 4px;
	}
</style>
