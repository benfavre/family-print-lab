<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { actions } from '$lib/client/actions';
	import { duration, hmsCode, stamp, temp } from '$lib/client/format';
	import PageHero from '$lib/components/PageHero.svelte';
	import StatTiles from '$lib/components/StatTiles.svelte';
	import JobCard from '$lib/components/JobCard.svelte';
	import TempChart from '$lib/components/TempChart.svelte';

	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);
	const labels: Record<string, string> = {
		IDLE: 'Idle',
		PREPARE: 'Preparing',
		RUNNING: 'Printing',
		PAUSE: 'Paused',
		FINISH: 'Finished',
		FAILED: 'Failed',
		SLICING: 'Slicing',
		UNKNOWN: 'Waiting for data'
	};
	const p = $derived(lab.printer);
	const s = $derived(p.state ?? null);
	const label = $derived(
		!p.connected ? 'Offline' : s ? (labels[s.gcodeState] ?? s.gcodeState) : 'Connecting…'
	);
	const linked = $derived(
		s?.task
			? lab.ws.jobs.find((j) => j.status === 'Printing' && j.printerTask === s.task)
			: undefined
	);
	const candidates = $derived(
		lab.ws.jobs.filter((j) => j.status === 'Queued' || (j.status === 'Printing' && !j.printerTask))
	);
	let chosen = $state('');
	/** Queued jobs with a sliced file, ready to send. */
	const ready = $derived(lab.ws.jobs.filter((j) => j.status === 'Queued' && j.sliced));
	/** Clock time the current print should finish, from the printer's remaining time. */
	const doneAt = $derived(
		lab.printerActive && s?.remainingMinutes
			? new Date(ui.now + s.remainingMinutes * 60_000).toLocaleTimeString(undefined, {
					hour: '2-digit',
					minute: '2-digit'
				})
			: ''
	);
	const errors = $derived([
		...(s?.printError
			? [`Print error ${s.printError.toString(16).toUpperCase().padStart(8, '0')}`]
			: []),
		...(s?.hms ?? []).map((h) => `HMS ${hmsCode(h)}`)
	]);
	const focus = $derived(linked ? (lab.project(linked.projectId)?.category ?? 'Home') : 'Home');
	const progress = $derived(
		lab.printerActive && s?.percent !== null && s?.percent !== undefined
			? s.percent / 100
			: s?.gcodeState === 'FINISH'
				? 1
				: null
	);

	function logNew() {
		const minutes =
			s?.remainingMinutes !== null && s?.remainingMinutes !== undefined && s.percent
				? Math.round(s.remainingMinutes / Math.max(1 - s.percent / 100, 0.01))
				: null;
		ui.openEditor('job', null, {
			status: 'Printing',
			printerTask: s?.task ?? '',
			revision: (s?.task ?? '').slice(0, 80),
			minutes,
			startedAt: new Date().toISOString()
		});
	}
</script>

<svelte:head><title>Printer · Family Print Lab</title></svelte:head>

<div class="layout">
	<div class="main-col">
		{#if !p.configured}
			<PageHero
				context={{ kind: 'printer' }}
				eyebrow="PRINTER LINK"
				title="Connect the printer"
				text="See live progress, temperatures and AMS filament here, send sliced plates straight to the printer, and let print jobs close themselves when it finishes. Everything stays on your network."
				note="Preview animation — no printer is connected"
			/>
			<div class="detail">
				<div class="detail-main">
					<section class="panel">
						<h2 class="panel-title">Set up in four steps</h2>
						<ol class="setup">
							<li>
								<strong>On the printer:</strong> Settings → WLAN / Network → turn on
								<em>LAN Mode Only</em>, then <em>Developer Mode</em>. Note the IP address and the
								8-character access code.
							</li>
							<li>
								<strong>Find the serial number</strong> in the printer's Settings → Device (also on the
								label at the back).
							</li>
							<li>
								<strong>Add</strong> <code>BAMBU_HOST</code>, <code>BAMBU_SERIAL</code> and
								<code>BAMBU_ACCESS_CODE</code>
								to <code>.env</code> (see <code>.env.example</code>). The file stays on this
								computer.
							</li>
							<li>
								<strong>Restart</strong> the app. This page turns live. Until the printer arrives,
								<code>npm run dev:sim</code> runs a simulated one.
							</li>
						</ol>
						<p class="panel-empty">
							LAN-only mode switches off Bambu's cloud features (remote printing from Bambu Handy).
						</p>
					</section>
				</div>
				<aside class="detail-side">
					<section class="panel">
						<h2 class="panel-title">What you get</h2>
						<ul class="bullets">
							<li>Live progress, layer and time left on jobs and the 3D stage</li>
							<li>Jobs linked to a print close as Succeeded or Failed automatically</li>
							<li>Nozzle, bed and chamber temperatures</li>
							<li>AMS slots with color and remaining filament</li>
							<li>Printer error codes</li>
						</ul>
					</section>
				</aside>
			</div>
		{:else}
			<PageHero
				context={{ kind: 'printer' }}
				eyebrow={p.simulated ? 'SIMULATED PRINTER · FOR DEVELOPMENT' : 'LIVE PRINTER'}
				title={p.name ?? 'Printer'}
				text={!p.connected
					? p.error || 'Waiting for the printer…'
					: s?.task
						? `${label}: ${s.task}`
						: label}
				{focus}
				{progress}
				note={lab.printerActive
					? 'Live progress from the printer · representative shape'
					: 'Representative shape — not the model on the plate'}
			>
				{#snippet extra()}
					<StatTiles
						label="Printer status"
						items={[
							{
								label: 'Progress',
								value: s?.percent !== null && s?.percent !== undefined ? `${s.percent}%` : '—',
								p: (s?.percent ?? 0) / 100,
								tone: 'Printing'
							},
							{
								label: 'Layer',
								value: s?.layer ?? '—',
								p: s?.totalLayers ? (s.layer ?? 0) / s.totalLayers : 0,
								tone: 'Planned'
							},
							{
								label: 'Time left',
								value:
									lab.printerActive &&
									s?.remainingMinutes !== null &&
									s?.remainingMinutes !== undefined
										? duration(s.remainingMinutes)
										: '—',
								p: 0,
								tone: 'Idea'
							},
							{
								label: 'Nozzle',
								value: temp(s?.nozzle),
								p: s?.nozzle ? Math.min(s.nozzle / 300, 1) : 0,
								tone: 'Done'
							}
						]}
					/>
				{/snippet}
			</PageHero>
			<div class="section-meta">
				<span
					>{p.simulated
						? 'Connected to the printer simulator — control it at http://127.0.0.1:8766'
						: ''}</span
				><span>Commands are sent only when you press a button here or send a job</span>
			</div>
			<div class="detail">
				<div class="detail-main">
					<section class="panel">
						<header class="panel-head">
							<h2>Current print</h2>
							{#if lab.printerActive}<span class="count live-dot"
									>LIVE{#if doneAt}&nbsp;· done around {doneAt}{/if}</span
								>{/if}
						</header>
						{#if lab.printerActive && p.connected}
							<div class="print-controls" role="group" aria-label="Print controls">
								{#if s?.gcodeState === 'PAUSE'}
									<button class="secondary" onclick={() => act.printerControl('resume')}
										>▶ Resume</button
									>
								{:else}
									<button class="secondary" onclick={() => act.printerControl('pause')}
										>❚❚ Pause</button
									>
								{/if}
								<button class="secondary danger" onclick={() => act.printerControl('stop')}
									>■ Stop</button
								>
							</div>
						{/if}
						{#if !lab.printerActive}
							<p class="panel-empty">
								Nothing printing right now. Send a queued job below, or start a print from Bambu
								Studio or the printer; it appears here.
							</p>
							{#if ready.length}
								<ul class="ready-list" aria-label="Ready to send">
									{#each ready as j (j.id)}
										{@const plate = j.sliced?.plates.find((x) => x.index === j.sliced?.plate)}
										<li data-job={j.id}>
											<span
												><b>{lab.project(j.projectId)?.title}</b>
												{j.revision}{#if plate}<small
														>&nbsp;· {duration(plate.minutes)} · {plate.grams} g</small
													>{/if}</span
											>
											<button class="mini primary-mini" onclick={() => act.sendToPrinter(j)}
												>▣ Send</button
											>
										</li>
									{/each}
								</ul>
							{/if}
						{:else if linked}
							<p class="panel-empty">
								Linked to this job. It closes as Succeeded or Failed when the printer finishes. <button
									class="mini"
									onclick={() => act.unlink(linked)}>Unlink</button
								>
							</p>
							<div class="job-list"><JobCard job={linked} now={ui.now} /></div>
						{:else}
							<p class="panel-empty">
								The printer is running <strong>“{s?.task || 'an unnamed print'}”</strong>, which
								isn't linked to a job yet.
							</p>
							{#if candidates.length}
								<div class="link-row">
									<select bind:value={chosen} aria-label="Job to link">
										<option value="" disabled>Choose a job…</option>
										{#each candidates as j (j.id)}<option value={j.id}
												>{lab.project(j.projectId)?.title} · {j.revision || j.status}</option
											>{/each}
									</select>
									<button
										class="mini primary-mini"
										disabled={!chosen}
										onclick={() => {
											const job = lab.ws.jobs.find((j) => j.id === chosen);
											if (job) act.linkRunning(job);
										}}>Link job</button
									>
								</div>
							{/if}
							<button class="mini" onclick={logNew}>＋ Log it as a new job</button>
						{/if}
					</section>
					<section class="panel">
						<h2 class="panel-title">AMS filament</h2>
						{#each s?.ams ?? [] as unit (unit.unit)}
							<div class="ams-unit">
								<header>
									<span>AMS {Number(unit.unit) + 1 || unit.unit}</span
									>{#if unit.humidity !== null}<small>humidity level {unit.humidity}</small>{/if}
								</header>
								<div class="ams-slots">
									{#each unit.trays as t (t.slot)}
										<div class="ams-slot" class:active={t.active} class:vacant={!t.type}>
											<span
												class="swatch big"
												style:--swatch={t.color}
												data-swatch={t.color ? '' : undefined}
												aria-hidden="true"
											></span>
											<strong>{t.type || 'Empty'}</strong>
											<small
												>{t.remain !== null
													? `${t.remain}% left`
													: t.type
														? 'amount unknown'
														: `slot ${Number(t.slot) + 1}`}</small
											>
											{#if t.type}
												<button
													class="mini"
													onclick={() =>
														ui.openEditor('spool', null, {
															material: t.type,
															colorHex: t.color ?? '#5ee7ff',
															remainingGrams: t.remain !== null ? t.remain * 10 : 1000,
															notes: `AMS ${Number(unit.unit) + 1} slot ${Number(t.slot) + 1}`
														})}>＋ Shelf</button
												>
											{/if}
										</div>
									{/each}
								</div>
							</div>
						{:else}
							<p class="panel-empty">No AMS data reported.</p>
						{/each}
					</section>
				</div>
				<aside class="detail-side">
					<section class="panel">
						<h2 class="panel-title">Temperatures</h2>
						<dl class="facts">
							<div>
								<dt>Nozzle</dt>
								<dd>{temp(s?.nozzle, s?.nozzleTarget)}</dd>
							</div>
							<div>
								<dt>Bed</dt>
								<dd>{temp(s?.bed, s?.bedTarget)}</dd>
							</div>
							<div>
								<dt>Chamber</dt>
								<dd>{temp(s?.chamber)}</dd>
							</div>
							<div>
								<dt>Speed</dt>
								<dd>
									{(
										{ 1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous' } as Record<
											number,
											string
										>
									)[s?.speedLevel ?? 0] ?? '—'}
								</dd>
							</div>
						</dl>
						<TempChart />
					</section>
					<section class="panel">
						<h2 class="panel-title">Alerts</h2>
						{#if errors.length}
							<ul class="alerts">
								{#each errors as e (e)}<li>{e}</li>{/each}
							</ul>
							<p class="panel-empty">Look codes up in Bambu Handy or the Bambu Lab wiki.</p>
						{:else}
							<p class="panel-empty">No errors reported.</p>
						{/if}
						{#if p.warning}<p class="error">{p.warning}</p>{/if}
					</section>
					<section class="panel">
						<h2 class="panel-title">Connection</h2>
						<dl class="facts one">
							<div>
								<dt>Status</dt>
								<dd>{p.connected ? 'Connected' : 'Offline'}</dd>
							</div>
							<div>
								<dt>Last report</dt>
								<dd>{stamp(p.lastSeen) || '—'}</dd>
							</div>
						</dl>
						{#if p.error && !p.connected}<p class="panel-empty">{p.error}</p>{/if}
					</section>
				</aside>
			</div>
		{/if}
	</div>
</div>

<style>
	.print-controls {
		display: flex;
		gap: 8px;
		margin: 0 0 12px;
	}
	.print-controls .danger {
		color: var(--red);
	}
	.ready-list {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.ready-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		font-size: 13px;
	}
	.ready-list small {
		color: var(--dim);
	}
</style>
